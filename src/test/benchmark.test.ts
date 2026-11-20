import { test } from "node:test";
import { strict as assert } from "node:assert";
import { benchmarkCases, scoreCase, scoreReviewResponses } from "../benchmark";
import { validateReview } from "../review";

test("benchmark scores mechanisms and locations without counting duplicate findings twice", () => {
  const fixture = benchmarkCases.find(c => c.id === "integer-overflow-bug")!;
  const result = validateReview(JSON.stringify({findings: [{title: "Integer overflow before promotion", severity: "medium",
    path: "Price.java", startLine: 3, endLine: 3, fix: "Promote before multiplication", regressionTest: "Large int inputs"}]}), fixture.sources);
  assert.equal(result.findings.length, 1);
  assert.deepEqual(scoreCase(fixture, [...result.findings, ...result.findings]), {truePositive: 1, falseNegative: 0, falsePositive: 1, cleanPass: false});
  assert.equal(scoreCase(fixture, [{...result.findings[0], title: "Wrong issue", fix: "Unrelated"}]).truePositive, 0);
  assert.equal(scoreCase(fixture, []).falseNegative, 1);
  assert.equal(scoreCase(benchmarkCases.find(c => !c.expected)!, []).cleanPass, true);
});

test("shared review scoring reports invalid responses and evidence rejections independently", () => {
  const responses = Object.fromEntries(benchmarkCases.map(fixture => [fixture.id, '{"findings":[]}']));
  responses["integer-overflow-bug"] = "invalid JSON";
  responses["null-guard-clean"] = JSON.stringify({findings: [{path: "Invented.java"}]});
  const score = scoreReviewResponses(responses);
  assert.equal(score.totals.invalidResponses, 1);
  assert.equal(score.totals.rejectedFindings, 1);
  assert.equal(score.totals.falseNegative, 7);
  assert.equal(score.precision, null);
  assert.equal(score.recall, 0);
  assert.throws(() => scoreReviewResponses({...responses, unknown: "{}"}), /every benchmark case/);
});

test("benchmark scores evidence in Python, TypeScript and JavaScript fixtures", () => {
  const responses = Object.fromEntries(benchmarkCases.map(fixture => [fixture.id, '{"findings":[]}']));
  for (const [id, path, line, title] of [
    ["python-mutable-default-bug", "events.py", 1, "Mutable default list leaks events across calls"],
    ["typescript-zero-limit-bug", "limits.ts", 3, "Falsy check discards explicit zero"],
    ["javascript-numeric-sort-bug", "scores.js", 3, "Default sort orders numeric values as strings"]
  ] as const) {
    responses[id] = JSON.stringify({findings: [{
      title, severity: "medium", path, startLine: line, endLine: line,
      fix: "Preserve documented behavior", regressionTest: "Check a triggering input"
    }]});
  }
  const score = scoreReviewResponses(responses);
  assert.equal(score.totals.truePositive, 3);
  assert.equal(score.totals.rejectedFindings, 0);
  assert.equal(score.totals.falsePositive, 0);
});
