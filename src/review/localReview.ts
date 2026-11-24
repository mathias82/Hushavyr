import { LocalOllama } from "../model/ollama";
import { ReviewResult, reviewPrompt, reviewSchema, validateReview } from "./review";
import { ReviewInput, reviewSources, validateContext } from "./context";
import { recheck, verifyReview } from "./verifyReview";
import { scanSecurity } from "../scan/securityRules";
import { Finding } from "./review";
import { flowSeverity, flowTitle, taintFlows } from "../scan/taint";
import { targetedFindings } from "./targetedChecks";
import { ReviewTrace } from "./reviewTrace";

export type ReviewDepth = "fast" | "thorough" | "light";
export type VerifyMode = "batch" | "recheck" | "hedged" | "none";
export interface ReviewOptions {
  /** "thorough" adds focused security and robustness passes; "fast" is one pass plus a retry when empty;
   * "light" (small machines) is one short pass; static candidates and the verifier carry the rest. */
  depth?: ReviewDepth;
  /** Static analyzer candidates (semgrep / bundled rules), triaged together with the model's findings. */
  staticFindings?: Promise<Finding[]>;
  /** Live status lines, e.g. "Security pass: 2 candidate(s)", shown while the review runs. */
  onProgress?: (message: string) => void;
  /** How the second pass checks findings: "batch" (one skeptical pass over all), "recheck" (one narrow yes/no
   * question per finding), "hedged" (only findings stated as possibilities; see verifyModeFor) or "none". Default "batch". */
  verify?: VerifyMode;
  /** A stronger local model (e.g. 32b) that re-judges only the findings the local checks disagree on; a yes promotes them. */
  judge?: Pick<LocalOllama, "generate"> | (() => Promise<Pick<LocalOllama, "generate"> | undefined>);
  /** Benchmark measurement: records what each stage proposed, kept or dropped. Never changes prompts, calls or findings. */
  trace?: ReviewTrace;
}

// Appended after the shared prompt so every pass reuses the same prompt prefix (Ollama keeps its KV cache).
export const LENSES = [
  "FOCUS FOR THIS PASS: security only. Look for injection (SQL, shell command, path, template, LDAP), cross-site scripting, unsafe deserialization, disabled TLS validation, weak cryptography, hardcoded credentials, SSRF and missing authorization checks. Report a finding only when an externally influenced value visibly reaches the sink.",
  "FOCUS FOR THIS PASS: robustness only. Look for null/undefined dereferences, off-by-one and boundary errors, integer overflow, falsy-zero defaults, wrong comparators or sorting, shared mutable defaults, unclosed resources, swallowed errors and race conditions."
];

const MECHANISMS: readonly RegExp[] = [/\bsql\b/i, /xss|cross.site|innerhtml/i, /command|shell|\bexec/i, /traversal/i, /deserializ|yaml|pickle/i,
  /\btls\b|certificat/i, /\bmd5\b|\bsha-?1\b|weak hash/i, /random/i, /secret|password|credential/i, /\bnull\b|nil\b/i, /overflow/i, /out of bounds|off.by.one/i];
const mechanisms = (f: Finding): number[] => MECHANISMS.flatMap((re, i) => re.test(f.title) ? [i] : []);

/** Same location (path and overlapping line range) means the same finding; so does the same mechanism on the next line. The first one wins. */
export function mergeFindings(...lists: readonly Finding[][]): Finding[] {
  const merged: Finding[] = [];
  for (const finding of lists.flat()) {
    const span = (f: Finding): [number, number] => [f.line ?? 0, (f.line ?? 0) + f.evidence.split("\n").length - 1];
    const [start, end] = span(finding);
    const kinds = mechanisms(finding);
    if (merged.some(m => { const [a, b] = span(m); return m.path === finding.path &&
      (a <= end && start <= b || a - 1 <= end && start <= b + 1 && mechanisms(m).some(k => kinds.includes(k))); })) continue;
    merged.push(finding);
    if (merged.length >= 20) break;
  }
  return merged;
}

const LENS_NAMES = ["Security pass", "Robustness pass"];
const LENS_STAGES = ["lens.security", "lens.robustness"];
const rejectedInto = (trace: ReviewTrace | undefined, stage: string) => trace && ((c: Parameters<ReviewTrace["rejected"]>[1]) => trace.rejected(stage, c));
const candidates = (r: ReviewResult): string => r.findings.length + " candidate(s)";

async function lensFindings(client: Pick<LocalOllama, "generate">, prompt: string, source: ReviewInput,
  cancelled: () => boolean, onProgress?: (message: string) => void, trace?: ReviewTrace): Promise<ReviewResult[]> {
  const results: ReviewResult[] = [];
  for (const [i, lens] of LENSES.entries()) {
    if (cancelled()) break;
    onProgress?.(LENS_NAMES[i] + "...");
    trace?.at(LENS_STAGES[i]);
    try {
      const result = validateReview(await client.generate(prompt + "\n\n" + lens, {schema: reviewSchema, maxTokens: REVIEW_TOKENS}), source, rejectedInto(trace, LENS_STAGES[i]));
      trace?.record(LENS_STAGES[i], result.findings, result.error);
      results.push(result);
      onProgress?.(LENS_NAMES[i] + ": " + candidates(result));
    } catch { /* one failed lens must not discard the other passes */ }
  }
  return results;
}

// A model stuck repeating itself (e.g. endless asserts in regressionTest) is cut here, well before
// Node's 300 s fetch header timeout; validateReview keeps the findings that were complete.
const REVIEW_TOKENS = 2048;
/** At most two local inference calls, plus model-metadata checks. Every attempt goes through the same evidence gate. */
async function collectFindings(
  client: Pick<LocalOllama, "generate">,
  instruction: string,
  source: ReviewInput,
  cancelled: () => boolean = () => false,
  depth: ReviewDepth = "fast",
  onProgress?: (message: string) => void,
  trace?: ReviewTrace
): Promise<ReviewResult | undefined> {
  if (cancelled()) return;
  const prompt = reviewPrompt(instruction, source);
  onProgress?.("General pass...");
  trace?.at("general");
  const raw = await client.generate(prompt, depth === "light" ? {schema: reviewSchema, maxTokens: 1536} : {schema: reviewSchema, maxTokens: REVIEW_TOKENS});
  if (cancelled()) return;
  const first = validateReview(raw, source, rejectedInto(trace, "general"));
  trace?.record("general", first.findings, first.error);
  onProgress?.("General pass: " + candidates(first));
  if (depth === "light") return first;
  if (depth === "thorough") {
    const passes = [first, ...await lensFindings(client, prompt, source, cancelled, onProgress, trace)];
    if (cancelled()) return;
    return {...first, findings: mergeFindings(...passes.map(p => p.findings)),
      proposed: passes.reduce((n, p) => n + (p.proposed ?? 0), 0),
      rejected: passes.reduce((n, p) => n + p.rejected, 0),
      rejectionReasons: [...new Set(passes.flatMap(p => p.rejectionReasons ?? []))]};
  }
  // An empty model response is inconclusive: make one focused local retry.
  // Never manufacture findings or bypass source evidence validation.
  if (first.findings.length) return first;
  const feedback = first.error ?? (first.proposed === 0 ? "No candidate findings were proposed." : first.rejectionReasons?.join("; ") ?? "Invalid finding");
  trace?.at("retry");
  try {
    const repaired = await client.generate(prompt +
      "\n\nLOCAL VALIDATOR FEEDBACK: " + feedback +
      "\nReview the source again, inspecting boundary conditions, error handling, and any visible concrete failure mechanisms. Correct the response shape and choose a valid source path and line range. " +
      "Discard any unsupported claim; return an empty findings array if no concrete issue is supported.",
      {schema: reviewSchema, maxTokens: REVIEW_TOKENS});
    if (cancelled()) return;
    const second = validateReview(repaired, source, rejectedInto(trace, "retry"));
    trace?.record("retry", second.findings, second.error);
    // Do not hide the original useful validation feedback behind a new parser error.
    return second.error ? {...first, retryFailed: true} : second;
  } catch {
    if (!cancelled()) return {...first, retryFailed: true};
  }
}

/** Independent offline indicators, never presented as AI-generated or confirmed vulnerabilities. */
function offlineSecurityFindings(source: ReviewInput): Finding[] {
  const findings: Finding[] = [];
  for (const file of reviewSources(source)) {
    const lines = file.text.split(/\r?\n/);
    // Detect Java HTTP responses assembled from an unescaped dynamic JSON string.
    // This is a narrow correctness check, not a generic concatenation alarm.
    if (file.path.toLowerCase().endsWith(".java")) {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.includes(".entity(") || !line.includes("+")) continue;
        if (!line.includes("\\\"") || !line.includes("{")) continue;
        findings.push({
          title: "Local rule: Dynamic value embedded in manually constructed JSON",
          severity: "medium", evidence: line,
          fix: "Serialize a response DTO or JSON object with the framework's JSON serializer rather than concatenating unescaped values.",
          regressionTest: "Use an input containing quotes and backslashes, then assert the HTTP response parses as valid JSON.",
          status: "potential", path: file.path, line: (file.startLine ?? 1) + i
        });
        if (findings.length >= 10) return findings;
      }
    }
    // Source-to-sink flows from the deterministic taint engine (same engine as /security), so a small model cannot drop them.
    for (const flow of taintFlows([{path: file.path, text: file.text}])) {
      const evidence = lines[flow.sink.line - 1];
      if (flow.sink.path !== file.path || !evidence || evidence.trim().length < 8) continue;
      findings.push({
        title: "Local rule: " + flowTitle(flow),
        severity: flowSeverity(flow), evidence,
        fix: "Do not build the sink argument from request input: use parameterized APIs, an allow-list or proper encoding.",
        regressionTest: "Send a malicious value in the request parameter from line " + ((file.startLine ?? 1) + flow.source.line - 1) + " and assert it is rejected or treated as data.",
        status: "potential", path: file.path, line: (file.startLine ?? 1) + flow.sink.line - 1
      });
      if (findings.length >= 10) return findings;
    }
    for (const issue of scanSecurity(file.path, file.text)) {
      // Only surface high-confidence, directly visible TLS misconfiguration here.
      // Broader heuristic checks remain in /security to avoid noisy /review output.
      if (issue.rule !== "TLS certificate validation disabled") continue;
      const evidence = lines[issue.line - 1];
      if (!evidence || evidence.trim().length < 8) continue;
      findings.push({
        title: "Local rule: TLS certificate validation disabled",
        severity: "high", evidence,
        fix: issue.advice,
        regressionTest: "Verify connections reject an invalid or untrusted certificate.",
        status: "potential", path: file.path,
        line: (file.startLine ?? 1) + issue.line - 1
      });
      if (findings.length >= 10) return findings;
    }
  }
  return findings;
}

/** Narrow per-finding verification: each finding is kept only if a focused look at its lines confirms it. */
async function recheckEach(verifier: Pick<LocalOllama, "generate">, result: ReviewResult, source: ReviewInput, cancelled: () => boolean): Promise<ReviewResult | undefined> {
  const findings: Finding[] = [];
  for (const [i, f] of result.findings.entries()) {
    if (cancelled()) return;
    if (i >= 6 || await recheck(verifier, f, source, cancelled)) findings.push({...f, verification: i >= 6 ? "unverified" : "supported"});
  }
  return {...result, findings, verifierRejected: result.findings.length - findings.length};
}

const HEDGED = /^(?:local rule:\s*)?(?:potential|possible|possibly|may|might|could)\b/i;
/** Small models: findings stated as fact are kept; only hedged ones ("Potential ...") go to the verifier. */
async function verifyHedged(verifier: Pick<LocalOllama, "generate">, result: ReviewResult, source: ReviewInput, cancelled: () => boolean): Promise<ReviewResult | undefined> {
  const hedged = result.findings.filter(f => HEDGED.test(f.title));
  if (!hedged.length) return result;
  const checked = await verifyReview(verifier, {...result, findings: hedged}, source, cancelled);
  if (!checked) return;
  const findings = result.findings.filter(f => !hedged.includes(f) || checked.findings.some(c => c.line === f.line && c.title === f.title));
  return {...checked, findings: findings.map(f => checked.findings.find(c => c.line === f.line && c.title === f.title) ?? f)};
}

/** Hybrid review: model passes + static analyzer candidates, then one separate verification pass; all local. */
export async function runLocalReview(
  client: Pick<LocalOllama, "generate">, instruction: string, source: ReviewInput,
  cancelled: () => boolean = () => false, verifier?: Pick<LocalOllama, "generate">,
  options: ReviewOptions = {}
): Promise<ReviewResult | undefined> {
  validateContext(instruction, reviewSources(source));
  const progress = options.onProgress, trace = options.trace;
  if (trace) { client = trace.client(client); if (verifier) verifier = trace.client(verifier); }
  const model = await collectFindings(client, instruction, source, cancelled, options.depth, progress, trace);
  if (!model || cancelled()) return;
  trace?.record("collected", model.findings, model.error);
  const staticCandidates = options.staticFindings ? await options.staticFindings.catch(() => []) : [];
  if (options.staticFindings) trace?.record("static", staticCandidates);
  if (options.staticFindings) progress?.("Static rules (Semgrep): " + staticCandidates.length + " candidate(s)");
  const result = staticCandidates.length && !model.error
    ? {...model, findings: mergeFindings(model.findings, staticCandidates), staticCandidates: staticCandidates.length}
    : model;
  const mode = (process.env.HUSHAVYR_VERIFY as VerifyMode | undefined) ?? options.verify ?? "batch";
  if (verifier && mode !== "none" && result.findings.length) progress?.("Second local pass: checking " + result.findings.length + " finding(s) against the source...");
  trace?.record("preVerify", result.findings);
  trace?.at("verify");
  const verified = !verifier || mode === "none" ? result : mode === "recheck" ? await recheckEach(verifier, result, source, cancelled)
    : mode === "hedged" ? await verifyHedged(verifier, result, source, cancelled) : await verifyReview(verifier, result, source, cancelled);
  if (!verified || cancelled()) return;
  trace?.record("verified", verified.findings, verified.verifierFailed ? "verifier failed" : undefined);
  trace?.record("disputed", verified.disputed ?? []);
  trace?.at("confirm");
  // Optional narrow confirmation of each kept finding (HUSHAVYR_CONFIRM=1, benchmark A/B): a "no" moves it to Possible.
  const doubted: Finding[] = [];
  if (process.env.HUSHAVYR_CONFIRM === "1" && verifier && !model.error) {
    const kept: Finding[] = [];
    for (const [i, f] of verified.findings.entries()) {
      if (i >= 3 || await recheck(verifier, f, source, cancelled)) kept.push(f); else doubted.push({...f, verification: "unverified"});
      if (cancelled()) return;
    }
    verified.findings = kept;
  }
  if (doubted.length) verified.disputed = [...verified.disputed ?? [], ...doubted];
  trace?.record("confirm.doubted", doubted);
  trace?.at("targeted");
  // Bug classes the general pass and the verifier often lose (overflow, missing await, falsy zero, null before guard, ...):
  // a narrow trigger plus one focused local question each. HUSHAVYR_TARGETED=0 turns them off (benchmark A/B).
  const targeted = process.env.HUSHAVYR_TARGETED === "0" || model.error ? [] : await targetedFindings(verifier ?? client, source, cancelled);
  if (cancelled()) return;
  if (targeted.length) progress?.("Focused checks: " + targeted.length + " finding(s)");
  trace?.record("targeted", targeted);
  trace?.at("judge");
  const promoted: Finding[] = [];
  const chosen = verified.disputed?.length && options.judge ? typeof options.judge === "function" ? await options.judge() : options.judge : undefined;
  const judge = chosen && trace ? trace.client(chosen) : chosen;
  if (judge && verified.disputed?.length) {
    progress?.("Stronger local model: re-checking " + verified.disputed.length + " disputed finding(s)...");
    for (const d of verified.disputed) {
      if (cancelled()) return;
      if (await recheck(judge, d, source, cancelled)) promoted.push({...d, verification: "supported"});
    }
  }
  const offline = offlineSecurityFindings(source);
  trace?.record("judge.promoted", promoted);
  trace?.record("offline", offline);
  const findings = mergeFindings(verified.findings, promoted, targeted, offline);
  const disputed = verified.disputed?.filter(d => !findings.some(f => f.path === d.path && Math.abs((f.line ?? 0) - (d.line ?? 0)) <= 1));
  trace?.record("final", findings);
  trace?.record("possible", disputed ?? []);
  return {...verified, findings, disputed: disputed?.length ? disputed : undefined};

}
