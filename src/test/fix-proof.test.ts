import {test} from "node:test";
import {strict as assert} from "node:assert";
import {FixProofContext, FixProofDependencies, ProofStage, TestRun, runFixProof, parseSurefire, sha256} from "../fixProof";
const context: FixProofContext = {baseCommit: "a".repeat(40), imageId: "sha256:" + "b".repeat(64),
  testClass: "example.RegressionTest", testPath: "src/test/java/example/RegressionTest.java"};
const oldCase = {className: "example.OldTest", name: "works", outcome: "passed" as const};
const newCase = {className: context.testClass, name: "reproduces", outcome: "passed" as const};
function fixture() {
  const calls: string[] = [];
  let cancelled = false;
  const runs: Record<ProofStage, TestRun> = {
    baseline: {exitCode: 0, interrupted: false, durationMs: 1, cases: [oldCase]},
    red: {exitCode: 1, interrupted: false, durationMs: 1, cases: [{...newCase, outcome: "failure"}]},
    green: {exitCode: 0, interrupted: false, durationMs: 1, cases: [newCase]},
    suite: {exitCode: 0, interrupted: false, durationMs: 1, cases: [oldCase, newCase]}
  };
  const deps: FixProofDependencies = {
    cancelled: () => cancelled,
    run: async stage => {calls.push(stage); return runs[stage];},
    proposeTest: async () => {calls.push("propose-test"); return "frozen source";},
    approveTest: async () => {calls.push("approve-test"); return true;},
    writeTest: async () => {calls.push("write-test");},
    proposeFix: async () => {calls.push("propose-fix"); return [{path: "src/main/java/example/App.java", content: "fixed"}];},
    approveFix: async () => {calls.push("approve-fix"); return true;},
    applyFix: async () => {calls.push("apply-fix");}
  };
  return {deps, runs, calls, cancel: () => {cancelled = true;}};
}
test("verified requires baseline, an actual assertion failure, identical green cases and passing suite", async () => {
  const f = fixture(), result = await runFixProof(context, f.deps);
  assert.equal(result.status, "verified"); assert.equal(result.testHash, sha256("frozen source"));
  assert.deepEqual(f.calls, ["baseline", "propose-test", "approve-test", "write-test", "red", "propose-fix", "approve-fix", "apply-fix", "green", "suite"]);
  assert.equal(result.stages.length, 4);
  assert.doesNotMatch(JSON.stringify(result), /reproduces|frozen source|example.OldTest/);
});
test("baseline failure, missing reports, timeouts and zero tests prevent model generation", async () => {
  for (const variant of [{exitCode: 1}, {interrupted: true}, {cases: []},
    {cases: [{...oldCase, outcome: "error" as const}]}]) {
    const f = fixture(); Object.assign(f.runs.baseline, variant);
    assert.equal((await runFixProof(context, f.deps)).status, "not-verified");
    assert.deepEqual(f.calls, ["baseline"]);
  }
});
test("passing, compile-error, runtime-error, skipped or interrupted red run is not a reproduction", async () => {
  for (const variant of [{exitCode: 0}, {cases: []}, {interrupted: true}, {exitCode: null},
    {cases: [{...newCase, outcome: "error" as const}]}, {cases: [{...newCase, outcome: "skipped" as const}]},
    {cases: [{...oldCase, outcome: "failure" as const}]}]) {
    const f = fixture(); Object.assign(f.runs.red, variant);
    assert.equal((await runFixProof(context, f.deps)).reason, "regression-not-reproduced");
    assert.ok(!f.calls.includes("propose-fix"));
  }
});
test("changed identities, duplicate cases or missing green tests prevent acceptance", async () => {
  for (const cases of [[], [{...newCase, name: "different"}], [newCase, newCase], [{...newCase, outcome: "skipped" as const}]]) {
    const f = fixture(); f.runs.green.cases = cases;
    assert.equal((await runFixProof(context, f.deps)).reason, "regression-not-fixed");
    assert.ok(!f.calls.includes("suite"));
  }
});
test("full suite must retain every previously passing test and the regression test", async () => {
  for (const cases of [[newCase], [oldCase], [{...oldCase, outcome: "skipped" as const}, newCase],
    [{...oldCase, outcome: "failure" as const}, newCase]]) {
    const f = fixture(); f.runs.suite.cases = cases;
    assert.equal((await runFixProof(context, f.deps)).reason, "suite-regressed-or-tests-disappeared");
  }
});
test("test and fix approvals are required before any corresponding write", async () => {
  const testDenied = fixture(); testDenied.deps.approveTest = async () => false;
  assert.equal((await runFixProof(context, testDenied.deps)).reason, "regression-test-not-approved");
  assert.ok(!testDenied.calls.includes("write-test"));
  const fixDenied = fixture(); fixDenied.deps.approveFix = async () => false;
  assert.equal((await runFixProof(context, fixDenied.deps)).reason, "fix-not-approved");
  assert.ok(!fixDenied.calls.includes("apply-fix"));
});
test("empty fixes, model errors and execution errors fail closed", async () => {
  const empty = fixture(); empty.deps.proposeFix = async () => [];
  assert.equal((await runFixProof(context, empty.deps)).reason, "empty-fix");
  const error = fixture(); error.deps.proposeTest = async () => {throw new Error("model claims verified");};
  assert.equal((await runFixProof(context, error.deps)).status, "not-verified");
  assert.ok(!error.calls.includes("apply-fix"));
});
test("cancellation prevents subsequent execution", async () => {
  const f = fixture(); f.deps.approveTest = async () => {f.cancel(); return true;};
  assert.equal((await runFixProof(context, f.deps)).status, "cancelled");
  assert.ok(!f.calls.includes("write-test"));
  const before = fixture(); before.cancel();
  assert.equal((await runFixProof(context, before.deps)).status, "cancelled");
  assert.deepEqual(before.calls, []);
});
test("approved production proposals are immutable while the preview is open", async () => {
  const f = fixture();
  f.deps.approveFix = async changes => {
    assert.ok(Object.isFrozen(changes)); assert.ok(Object.isFrozen(changes[0])); return true;
  };
  assert.equal((await runFixProof(context, f.deps)).status, "verified");
});
const xml = (body: string, totals = 'tests="1" failures="0" errors="0" skipped="0"') =>
  '<?xml version="1.0"?><testsuite ' + totals + '>' + body + '</testsuite>';
test("restricted Surefire parser reads pass and assertion-failure evidence", () => {
  assert.equal(parseSurefire(xml('<testcase classname="A" name="x"/>'))[0].outcome, "passed");
  assert.equal(parseSurefire(xml('<testcase classname="A" name="x"><failure message="wrong"/></testcase>',
    'tests="1" failures="1" errors="0" skipped="0"'))[0].outcome, "failure");
});
test("report totals, duplicate identities, DTDs and control characters cannot manufacture proof", () => {
  for (const report of [xml('<testcase classname="A" name="x"/>', 'tests="9" failures="0" errors="0"'),
    '<!DOCTYPE x [<!ENTITY x SYSTEM "file:///private">]>' + xml('<testcase classname="A" name="x"/>'),
    xml('<testcase classname="A" name="x"/><testcase classname="A" name="x"/>', 'tests="2" failures="0" errors="0" skipped="0"'),
    xml('<testcase classname="A" name="x\u0000"/>'), 'not XML']) assert.throws(() => parseSurefire(report));
});
