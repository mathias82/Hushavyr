import { LocalOllama } from "./ollama";
import { ReviewSource } from "./context";
import { Finding } from "./review";
import { runLocalReview } from "./localReview";

export interface BenchmarkCase { id: string; sources: ReviewSource[]; expected?: {path: string; line: number; mechanism: RegExp} }
// Synthetic, public examples. Scores measure this small fixture set only.
export const benchmarkCases: BenchmarkCase[] = [
  {id: "json-escaping-bug", sources: [{path: "Mapper.java", text: String.raw`class Mapper {
  String error(String tenantId) {
    return "{\"error\":\"" + tenantId + "\"}";
  }
}`}], expected: {path: "Mapper.java", line: 3, mechanism: /json|escap|serializ/i}},
  {id: "json-serializer-clean", sources: [{path: "Mapper.java", text: `import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.Map;
class Mapper {
  String error(String tenantId) throws JsonProcessingException {
    return new ObjectMapper().writeValueAsString(Map.of("error", tenantId == null ? "" : tenantId));
  }
}`}]},
  {id: "null-before-guard-bug", sources: [{path: "Names.java", text: `class Names {
  String normalize(String value) {
    String result = value.trim();
    return value == null ? "" : result;
  }
}`}], expected: {path: "Names.java", line: 3, mechanism: /null|dereferen/i}},
  {id: "null-guard-clean", sources: [{path: "Names.java", text: `class Names {
  String normalize(String value) {
    return value == null ? "" : value.trim();
  }
}`}]},
  {id: "integer-overflow-bug", sources: [{path: "Price.java", text: `class Price {
  long total(int quantity, int unitCents) {
    return quantity * unitCents;
  }
}`}], expected: {path: "Price.java", line: 3, mechanism: /overflow|integer|multipli|32.bit/i}},
  {id: "integer-promotion-clean", sources: [{path: "Price.java", text: `class Price {
  long total(int quantity, int unitCents) {
    return (long) quantity * unitCents;
  }
}`}]},
  {id: "cross-file-null-bug", sources: [{path: "Lookup.java", text: `class Lookup {
  String find(int id) { return null; }
}`}, {path: "Service.java", text: `class Service {
  String name(Lookup lookup, int id) {
    if (lookup == null) return "";
    return lookup.find(id).trim();
  }
}`}], expected: {path: "Service.java", line: 4, mechanism: /null|dereferen/i}},
  {id: "cross-file-guard-clean", sources: [{path: "Lookup.java", text: `class Lookup {
  String find(int id) { return null; }
}`}, {path: "Service.java", text: `class Service {
  String name(Lookup lookup, int id) {
    if (lookup == null) return "";
    String value = lookup.find(id);
    return value == null ? "" : value.trim();
  }
}`}]} 
];

export function scoreCase(fixture: BenchmarkCase, findings: readonly Finding[]) {
  const expected = fixture.expected;
  const matched = expected ? findings.findIndex(f => f.path === expected.path && f.line !== undefined &&
    f.line <= expected.line && f.line + f.evidence.split('\n').length > expected.line &&
    expected.mechanism.test(f.title + " " + f.fix)) : -1;
  return {truePositive: matched >= 0 ? 1 : 0, falseNegative: expected && matched < 0 ? 1 : 0,
    falsePositive: findings.length - (matched >= 0 ? 1 : 0), cleanPass: !expected && !findings.length};
}
async function main() {
  const model = process.env.OLLAMA_MODEL ?? "qwen2.5-coder:7b";
  const verifierModel = process.env.OLLAMA_VERIFIER_MODEL ?? model;
  const endpoint = process.env.OLLAMA_ENDPOINT;
  const client = new LocalOllama({model, endpoint, timeoutMs: 180000});
  const verifier = new LocalOllama({model: verifierModel, endpoint, timeoutMs: 180000});
  await client.ensureAvailable();
  if (verifierModel !== model) await verifier.ensureAvailable();
  let tp = 0, fp = 0, fn = 0, errors = 0, verifierFailures = 0;
  const cases: object[] = [];
  for (const fixture of benchmarkCases) {
    const started = Date.now();
    try {
      const result = await runLocalReview(client, "Review for concrete correctness bugs. Input parameters may be null or any value of their declared type unless guarded in source.", fixture.sources, () => false, verifier);
      if (!result || result.error) throw new Error("Review failed");
      const score = scoreCase(fixture, result.findings);
      tp += score.truePositive; fp += score.falsePositive; fn += score.falseNegative;
      if (result.verifierFailed) verifierFailures++;
      cases.push({id: fixture.id, ...score, verifierFailed: !!result.verifierFailed, durationMs: Date.now() - started});
    } catch {
      errors++; if (fixture.expected) fn++;
      cases.push({id: fixture.id, error: true, durationMs: Date.now() - started});
    }
  }
  console.log(JSON.stringify({model, verifierModel, fixtureCount: benchmarkCases.length, cases,
    truePositives: tp, falsePositives: fp, falseNegatives: fn, errors, verifierFailures,
    precision: tp + fp ? tp / (tp + fp) : null, recall: tp + fn ? tp / (tp + fn) : null,
    limitation: "Synthetic fixture benchmark only. No Sonnet or Sol comparison was executed. No raw source or model response is included."}, null, 2));
  if (errors || verifierFailures || fp || fn) process.exitCode = 1;
}
if (require.main === module) main().catch(() => {
  console.error("Local benchmark unavailable. Check Ollama and installed models. No cloud request was made.");
  process.exitCode = 1;
});
