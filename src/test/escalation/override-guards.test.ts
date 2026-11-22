import { test } from "node:test";
import { strict as assert } from "node:assert";
import { requestCloudOverride } from "../../escalation/override";
const policy = {cloudEnabled:true,allowOverrides:true};
const approval = {reason:"Reviewed public sample for cloud use",confirmedCloudTransfer:true};
test("untrusted workspace never permits override", () => {
  const r = requestCloudOverride({prompt:"Write a Java class",workspaceTrusted:false},policy,approval);
  assert.equal(r.allowed,false);
  assert.ok(r.reasons.includes("untrusted-workspace"));
});
test("empty input cannot be overridden", () => {
  const r = requestCloudOverride({prompt:" ",workspaceTrusted:true},policy,approval);
  assert.equal(r.allowed,false);
  assert.ok(r.reasons.includes("empty-context"));
});
test("confidential marker cannot be overridden", () => {
  const r = requestCloudOverride({prompt:"CONFIDENTIAL customer memo",workspaceTrusted:true},policy,approval);
  assert.equal(r.allowed,false);
  assert.ok(r.reasons.includes("non-overridable-risk"));
});
test("approval requires explicit confirmation", () => {
  const r = requestCloudOverride({prompt:"Refactor Java code",workspaceTrusted:true},policy,{...approval,confirmedCloudTransfer:false});
  assert.equal(r.allowed,false);
});
test("mandatory local-only policy wins", () => {
  const r = requestCloudOverride({prompt:"Refactor Java code",workspaceTrusted:true},{...policy,mandatoryLocalOnly:true},approval);
  assert.equal(r.allowed,false);
});
