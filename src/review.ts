import { ReviewInput, reviewSources, sourcePrompt } from "./context";
/** Evidence-gated local review: never promote unverified model claims to confirmed bugs. */
export interface Finding { title: string; severity: string; evidence: string; fix: string; regressionTest: string; status: "potential" | "confirmed"; path?: string; line?: number; verification?: "supported" | "unverified" }
export interface ReviewResult { findings: Finding[]; rejected: number; proposed?: number; error?: string; rejectionReasons?: string[]; retryFailed?: boolean; verifierRejected?: number; verifierFailed?: boolean }
// Ollama constrains the shape; source validation below still decides what can be shown.
export const reviewSchema = {
  type: "object",
  required: ["findings"],
  additionalProperties: false,
  properties: {
    findings: {type: "array", maxItems: 20, items: {
      type: "object", additionalProperties: false,
      required: ["title", "severity", "startLine", "endLine", "fix", "regressionTest", "path"],
      properties: {
        title: {type: "string"}, severity: {type: "string", enum: ["high", "medium", "low"]},
        startLine: {type: "integer", minimum: 1}, endLine: {type: "integer", minimum: 1},
        fix: {type: "string"}, regressionTest: {type: "string"}, path: {type: "string"}
      }
    }}
  }
} as const;
const codeFence = /\x60{3}(?:json)?\s*([\s\S]*?)\x60{3}/i;
function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function field(obj: Record<string, unknown>, key: string): string {
  return typeof obj[key] === "string" ? (obj[key] as string).trim() : "";
}
export function reviewPrompt(instruction: string, code: ReviewInput): string {
  return [
    "You are a skeptical code reviewer. Review each source using its own language and runtime semantics. Use the file name and source syntax to identify the language. Follow relevant boundaries between languages when both sides are supplied. Return ONLY valid JSON, no Markdown.",
    'Schema: {"findings":[{"title":"...","severity":"high|medium|low","path":"exact SOURCE path","startLine":1,"endLine":2,"fix":"...","regressionTest":"..."}]}.',
    "Only report concrete failure mechanisms visible in supplied code. Never claim SQL injection without a SQL query or execution sink in the provided code.",
    "Do not claim a getter throws exceptions unless source code shows that behavior.",
    "Evidence MUST be an exact verbatim substring of the provided source code, at least 8 characters. The extension extracts it from your line range; do not copy escaped source into JSON.",
    "Choose the narrowest source range supporting the failure: startLine and endLine are inclusive, 1-based, and at most 8 lines apart including both endpoints.",
    "Use only the supplied files. Follow calls across supplied files when possible; do not assume implementations or validation in absent files. Set path to the exact SOURCE path containing the evidence.",
    "Inspect correctness at input/output boundaries: serialization and escaping, null handling, state changes and error responses. Explain a concrete triggering input and its effect in the title or fix. Do not invent absent behavior.",
    "If evidence is insufficient, return an empty findings array. Do not invent tests, other files, or execution results.",
    "User request: " + instruction,
    sourcePrompt(code)
  ].join("\n\n");
}
export function validateReview(raw: string, source: ReviewInput): ReviewResult {
  const sources = reviewSources(source);
  const combined = sources.map(s => s.text).join("\n");
  let parsed: unknown;
  try {
    const match = raw.match(codeFence);
    parsed = JSON.parse(match ? match[1] : raw);
  } catch { return {findings:[],rejected:0,error:"Model did not return valid JSON"}; }
  const obj = record(parsed);
  if (!obj || !Array.isArray(obj.findings)) return {findings:[],rejected:0,error:"Missing findings array"};
  const findings: Finding[] = [];
  const proposed = Math.min(obj.findings.length, 20);
  let rejected = 0;
  const rejectionReasons = new Set<string>();
  const reject = (reason: string): void => { rejected++; rejectionReasons.add(reason); };
  for (const candidate of obj.findings.slice(0,20)) {
    const item = record(candidate);
    if (!item) { reject("Finding must be an object"); continue; }
    const title=field(item,"title"),severity=field(item,"severity").toLowerCase();
    let evidence=field(item,"evidence");
    const fix=field(item,"fix"),regressionTest=field(item,"regressionTest");
    const path = field(item, "path");
    const eligible = path ? sources.filter(s => s.path === path) : (sources.length === 1 ? sources : []);
    const start = item.startLine, end = item.endLine;
    const hasRange = start !== undefined || end !== undefined;
    const lines = eligible.length === 1 ? eligible[0].text.replace(/\r\n/g,"\n").split("\n") : [];
    const offset = eligible[0]?.startLine ?? 1;
    const validRange = Number.isInteger(start) && Number.isInteger(end) &&
      (start as number) >= offset && (end as number) >= (start as number) &&
      (end as number) < offset + lines.length && (end as number) - (start as number) < 8;
    const rangeEvidence = validRange ? lines.slice((start as number) - offset, (end as number) - offset + 1).join("\n") : "";
    if (!evidence && validRange) evidence = rangeEvidence;
    const matched = eligible.find(s => s.text.replace(/\r\n/g,"\n").includes(evidence.replace(/\r\n/g,"\n")));
    const normalizedSource = matched?.text.replace(/\r\n/g,"\n") ?? "";
    const exactEvidence = evidence.length >= 8 && normalizedSource.includes(evidence.replace(/\r\n/g,"\n"));
    const hasSqlSink = /\b(prepareStatement|createStatement|executeQuery|executeUpdate|EntityManager|createNativeQuery|JdbcTemplate|SELECT\s|INSERT\s|UPDATE\s|DELETE\s)\b/i.test(combined);
    const unsupportedSql = /sql\s*injection/i.test(title) && !hasSqlSink;
    const unsupportedGetter = /(?:exception handling|unhandled exception)/i.test(title) && /getTenantId\(\)/.test(evidence) && !/throw\s+new/.test(combined);
    const reasons: string[] = [];
    if (!title || !fix || !regressionTest) reasons.push("Required title, fix or regressionTest is missing");
    if (!["high","medium","low"].includes(severity)) reasons.push("Severity must be high, medium or low");
    if (!exactEvidence) reasons.push("Evidence must copy an exact source substring of at least 8 characters");
    if (hasRange && !validRange) reasons.push("Source line range must be within the supplied file and at most 8 lines");
    if (validRange && !rangeEvidence.includes(evidence.replace(/\r\n/g,"\n"))) reasons.push("Quoted evidence does not belong to the supplied line range");
    if (!eligible.length) reasons.push("Path must identify a supplied source file");
    if (unsupportedSql) reasons.push("SQL injection claim has no SQL sink in supplied source");
    if (unsupportedGetter) reasons.push("Getter exception claim has no supporting throw in supplied source");
    if (reasons.length) { reject(reasons.join("; ")); continue; }
    const line = validRange ? start as number : normalizedSource.slice(0, normalizedSource.indexOf(evidence.replace(/\r\n/g,"\n"))).split("\n").length + (matched?.startLine ?? 1) - 1;
    findings.push({title,severity,evidence,fix,regressionTest,status:"potential",path:matched!.path,line});
  }
  return {findings,rejected,proposed,rejectionReasons:[...rejectionReasons]};
}
export function formatReview(result: ReviewResult): string {
  if (result.error) return "**Review not verified:** " + result.error + ". No findings promoted." +
    (result.retryFailed ? " The local repair attempt also failed." : "") + " Try again with a smaller selection.";
  const lines = ["### Evidence-gated local review", "", "All findings are **potential**, not confirmed. Tests were suggested, not executed.", ""];
  lines.push("**Review diagnostics:** " + (result.proposed ?? result.findings.length + result.rejected) + " proposed · " + result.findings.length + " passed source validation · " + result.rejected + " rejected by source validation · " + (result.verifierRejected ?? 0) + " rejected by second local pass.", "");
  if (!result.findings.length) lines.push(result.proposed === 0 ? "The local model proposed no findings. This does not establish that the code is bug-free." : "No findings passed the evidence checks. The review was inconclusive; this does not establish that the code is bug-free.", "");
  for (const [i,f] of result.findings.entries()) lines.push(
    "#### " + (i+1) + ". " + f.title,
    "**Status:** Potential · **Severity:** " + f.severity,
    "**Location:** " + JSON.stringify(f.path ?? "selection") + ":" + (f.line ?? "?"),
    "**Second local pass:** " + (f.verification === "supported" ? "Source support agreed; no runtime proof." : "Not verified."),
    "**Source evidence:**", "\x60\x60\x60java\n" + f.evidence + "\n\x60\x60\x60",
    "**Proposed fix:** " + f.fix,
    "**Regression test to implement:** " + f.regressionTest, ""
  );
  lines.push("_Filtered " + result.rejected + " unsupported or malformed finding(s). Source matching is not proof of runtime exploitability._");
  if (result.rejectionReasons?.length) lines.push("", "**Validation feedback:**", ...result.rejectionReasons.map(reason => "- " + reason));
  if (result.retryFailed) lines.push("", "The local repair attempt failed. These are the first attempt's validated results.");
  if (result.verifierRejected) lines.push("", "Second local pass rejected " + result.verifierRejected + " finding(s) as unsupported.");
  if (result.verifierFailed) lines.push("", "Second local pass was unavailable or invalid; findings remain unverified.");
  return lines.join("\n");
}

