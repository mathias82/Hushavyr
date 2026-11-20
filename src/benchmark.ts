import { LocalOllama } from "./ollama";
import { ReviewSource } from "./context";
import { Finding, reviewPrompt, validateReview } from "./review";
import { readFileSync } from "node:fs";
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
}`}]},
  {id: "python-mutable-default-bug", sources: [{path: "events.py", text: `def add_event(event, events=[]):
    events.append(event)
    return events`}], expected: {path: "events.py", line: 1, mechanism: /mutable|shared|default/i}},
  {id: "python-mutable-default-clean", sources: [{path: "events.py", text: `def add_event(event, events=None):
    if events is None:
        events = []
    events.append(event)
    return events`}]},
  {id: "typescript-zero-limit-bug", sources: [{path: "limits.ts", text: `// An explicit limit of zero must stay zero.
export function getLimit(limit?: number): number {
  return limit || 10;
}`}], expected: {path: "limits.ts", line: 3, mechanism: /zero|0|nullish|falsy/i}},
  {id: "typescript-zero-limit-clean", sources: [{path: "limits.ts", text: `// An explicit limit of zero must stay zero.
export function getLimit(limit?: number): number {
  return limit ?? 10;
}`}]},
  {id: "javascript-numeric-sort-bug", sources: [{path: "scores.js", text: `// Return a sorted copy in ascending numeric order.
export function sortedScores(scores) {
  return [...scores].sort();
}`}], expected: {path: "scores.js", line: 3, mechanism: /string|lexicograph|comparator|numeric/i}},
  {id: "java-sql-injection-bug", sources: [{path: "UserLookup.java", text: `import java.sql.*;
class UserLookup {
  ResultSet find(Statement stmt, String user) throws SQLException {
    return stmt.executeQuery("SELECT * FROM users WHERE name = '" + user + "'");
  }
}`}], expected: {path: "UserLookup.java", line: 4, mechanism: /sql|inject|parameter|query/i}},
  {id: "java-sql-parameterized-clean", sources: [{path: "UserLookup.java", text: `import java.sql.*;
class UserLookup {
  ResultSet find(Connection connection, String user) throws SQLException {
    PreparedStatement stmt = connection.prepareStatement("SELECT * FROM users WHERE name = ?");
    stmt.setString(1, user);
    return stmt.executeQuery();
  }
}`}]},
  {id: "javascript-tls-validation-disabled", sources: [{path: "client.js", text: `import https from "node:https";
export const agent = new https.Agent({rejectUnauthorized: false});`}], expected: {path: "client.js", line: 2, mechanism: /tls|certificat|validat|https/i}},
  {id: "javascript-tls-default-clean", sources: [{path: "client.js", text: `import https from "node:https";
export const agent = new https.Agent({rejectUnauthorized: true});`}]},
  {id: "python-shell-injection-bug", sources: [{path: "runner.py", text: `import subprocess
def run(command):
    return subprocess.run(command, shell=True, check=True)`}], expected: {path: "runner.py", line: 3, mechanism: /shell|inject|command|subprocess/i}},
  {id: "python-shell-argument-list-clean", sources: [{path: "runner.py", text: `import subprocess
def run(filename):
    return subprocess.run(["cat", "--", filename], shell=False, check=True)`}]},
  {id: "javascript-numeric-sort-clean", sources: [{path: "scores.js", text: `// Return a sorted copy in ascending numeric order.
export function sortedScores(scores) {
  return [...scores].sort((a, b) => a - b);
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
const instruction = "Review for concrete correctness bugs. Input parameters may be null or any value of their declared type unless guarded in source.";

export function scoreReviewResponses(responses: Record<string, unknown>) {
  const ids = benchmarkCases.map(fixture => fixture.id);
  if (Object.keys(responses).length !== ids.length || ids.some(id => typeof responses[id] !== "string")) {
    throw new Error("Provide one response string for every benchmark case ID.");
  }
  const cases = benchmarkCases.map(fixture => {
    const review = validateReview(responses[fixture.id] as string, fixture.sources);
    const score = scoreCase(fixture, review.findings);
    return {id: fixture.id, ...score, cleanPass: score.cleanPass && !review.error && review.rejected === 0,
      rejectedFindings: review.rejected, invalidResponse: Boolean(review.error)};
  });
  const totals = cases.reduce((sum, row) => ({
    truePositive: sum.truePositive + row.truePositive,
    falsePositive: sum.falsePositive + row.falsePositive,
    falseNegative: sum.falseNegative + row.falseNegative,
    rejectedFindings: sum.rejectedFindings + row.rejectedFindings,
    invalidResponses: sum.invalidResponses + Number(row.invalidResponse)
  }), {truePositive: 0, falsePositive: 0, falseNegative: 0, rejectedFindings: 0, invalidResponses: 0});
  const {truePositive: tp, falsePositive: fp, falseNegative: fn} = totals;
  return {cases, totals, precision: tp + fp ? tp / (tp + fp) : null, recall: tp + fn ? tp / (tp + fn) : null};
}

async function main(args: string[]) {
  if (args.length === 1 && args[0] === "--prompts") {
    console.log(JSON.stringify(Object.fromEntries(benchmarkCases.map(fixture =>
      [fixture.id, reviewPrompt(instruction, fixture.sources)])), null, 2));
    return;
  }
  if (args.length === 2 && args[0] === "--score") {
    const responses: unknown = JSON.parse(readFileSync(args[1], "utf8"));
    if (!responses || typeof responses !== "object" || Array.isArray(responses)) {
      throw new Error("Expected a JSON object mapping case IDs to response strings.");
    }
    console.log(JSON.stringify(scoreReviewResponses(responses as Record<string, unknown>), null, 2));
    return;
  }
  if (args.length) throw new Error("Usage: review:benchmark [--prompts | --score responses.json]");

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
      const result = await runLocalReview(client, instruction, fixture.sources, () => false, verifier);
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
if (require.main === module) main(process.argv.slice(2)).catch((error: Error) => {
  console.error("Benchmark stopped:", error.message);
  process.exitCode = 1;
});
