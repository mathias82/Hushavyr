import {test} from "node:test";
import {strict as assert} from "node:assert";
import {FixProofReceipt, sha256} from "../fixProof";
import {validateProof, assertMatchingRemote, githubRemote, scanResult} from "../fixPrPolicy";

const patch = Buffer.from("safe verified patch");
function receipt(): FixProofReceipt & {patchHash: string} {
  const stage = (name: "baseline"|"red"|"green"|"suite", red = false) => ({
    stage:name, exitCode:red?1:0, interrupted:false, durationMs:1,
    passed:1, failures:red?1:0, errors:0, skipped:0, caseSetHash:"x"
  });
  return {baseCommit:"a".repeat(40), imageId:"image",testClass:"Test",testPath:"Test.java",
    policyVersion:"maven-red-green-v1",runId:"run",startedAtUtc:"2026-01-01",
    status:"verified",reason:"red-green-and-suite-passed",testHash:"c".repeat(64),
    patchHash:sha256(patch),stages:[stage("baseline"),stage("red",true),stage("green"),stage("suite")]};
}
test("valid complete proof accepted",()=>assert.doesNotThrow(()=>validateProof(receipt(),patch)));
test("failed suite or fabricated stages rejected",()=>{
  const failed=receipt();failed.stages[3].exitCode=1;
  assert.throws(()=>validateProof(failed,patch));
  const missing=receipt();missing.stages.pop();
  assert.throws(()=>validateProof(missing,patch));
});
test("tampered patch and incomplete red stage rejected",()=>{
  assert.throws(()=>validateProof(receipt(),Buffer.from("tampered")));
  const failed=receipt();failed.stages[1].failures=0;
  assert.throws(()=>validateProof(failed,patch));
});
test("GitHub HTTPS and SSH origins must match selected repository",()=>{
  assert.equal(githubRemote("git@github.com:Owner/Repo.git"),"owner/repo");
  assert.doesNotThrow(()=>assertMatchingRemote("https://github.com/Owner/Repo.git","owner/repo"));
  assert.throws(()=>assertMatchingRemote("git@github.com:attacker/repo.git","owner/repo"));
  assert.throws(()=>githubRemote("https://github.com.evil.test/owner/repo"));
});
test("secret scanner errors or findings block publishing",()=>{
  assert.doesNotThrow(()=>scanResult(0,""));
  assert.throws(()=>scanResult(1,"credential"));
  assert.throws(()=>scanResult(2,""));
});
