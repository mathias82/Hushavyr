import { LocalOllama } from "./ollama";
import { ReviewResult, reviewPrompt, reviewSchema, validateReview } from "./review";
import { ReviewInput, reviewSources, validateContext } from "./context";
import { verifyReview } from "./verifyReview";
import { scanSecurity } from "./securityRules";
import { Finding } from "./review";

/** At most two local inference calls, plus model-metadata checks. Every attempt goes through the same evidence gate. */
async function collectFindings(
  client: Pick<LocalOllama, "generate">,
  instruction: string,
  source: ReviewInput,
  cancelled: () => boolean = () => false
): Promise<ReviewResult | undefined> {
  if (cancelled()) return;
  const prompt = reviewPrompt(instruction, source);
  const raw = await client.generate(prompt, {schema: reviewSchema});
  if (cancelled()) return;
  const first = validateReview(raw, source);
  // An empty model response is inconclusive: make one focused local retry.
  // Never manufacture findings or bypass source evidence validation.
  if (first.findings.length) return first;
  const feedback = first.error ?? (first.proposed === 0 ? "No candidate findings were proposed." : first.rejectionReasons?.join("; ") ?? "Invalid finding");
  try {
    const repaired = await client.generate(prompt +
      "\n\nLOCAL VALIDATOR FEEDBACK: " + feedback +
      "\nReview the source again, inspecting boundary conditions, error handling, and any visible concrete failure mechanisms. Correct the response shape and choose a valid source path and line range. " +
      "Discard any unsupported claim; return an empty findings array if no concrete issue is supported.",
      {schema: reviewSchema});
    if (cancelled()) return;
    const second = validateReview(repaired, source);
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
    if (/\\.java$/i.test(file.path)) {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!/\\.entity\\s*\\(/.test(line) || !/\\+\\s*[A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*\\(\\))?/.test(line)) continue;
        if (!/\\\\\"/.test(line) || !/\\{/.test(line)) continue;
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

/** Review + one possible repair + one separate verification pass; all local. */
export async function runLocalReview(
  client: Pick<LocalOllama, "generate">, instruction: string, source: ReviewInput,
  cancelled: () => boolean = () => false, verifier?: Pick<LocalOllama, "generate">
): Promise<ReviewResult | undefined> {
  validateContext(instruction, reviewSources(source));
  const result = await collectFindings(client, instruction, source, cancelled);
  if (!result || cancelled()) return;
  const verified = verifier ? await verifyReview(verifier, result, source, cancelled) : result;
  if (!verified || cancelled()) return;
  const offline = offlineSecurityFindings(source).filter(indicator =>
    !verified.findings.some(f => f.path === indicator.path && f.line === indicator.line));
  return {...verified, findings: [...verified.findings, ...offline]};

}
