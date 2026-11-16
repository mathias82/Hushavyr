import { test } from "node:test";
import { strict as assert } from "node:assert";
import { benchmarkCases, scoreCase } from "../benchmark";
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
