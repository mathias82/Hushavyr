import { test } from "node:test";
import { strict as assert } from "node:assert";
import { requestCloudOverride } from "../override";

const policy = {cloudEnabled:true,allowOverrides:true};
const request = {reason:"I reviewed this public example and confirmed it contains no restricted data",confirmedCloudTransfer:true};
test("explicit override of ordinary text",()=>{
  const result=requestCloudOverride({prompt:"Explain this public Java snippet",workspaceTrusted:true},policy,request);
  assert.equal(result.allowed,true);
  assert.equal(result.decision.route,"cloud-eligible");
});
test("deny without explicit confirmation",()=>{
  assert.equal(requestCloudOverride({prompt:"Hello"},policy,{...request,confirmedCloudTransfer:false}).allowed,false);
});
test("mandatory local-only cannot be overridden",()=>{
  assert.equal(requestCloudOverride({prompt:"Hello"},{...policy,mandatoryLocalOnly:true},request).allowed,false);
});
test("secrets cannot be overridden",()=>{
  const result=requestCloudOverride({prompt:"api_key=supersecret123"},policy,request);
  assert.equal(result.allowed,false);
  assert.ok(result.reasons.includes("non-overridable-risk"));
});
test("unknown attachments cannot be overridden",()=>{
  assert.equal(requestCloudOverride({prompt:"Summarize",attachments:[{path:"a.pdf"}]},policy,request).allowed,false);
});
test("reviewer approval enforced",()=>{
  assert.equal(requestCloudOverride({prompt:"Hello"},{...policy,requireReviewer:true},request).allowed,false);
});
