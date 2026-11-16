import { test } from "node:test";
import { strict as assert } from "node:assert";
import { classify, classifyInput } from "../classifier";

test("credentials stay local even for coding", () => {
  const d = classifyInput({prompt:"Debug this Java class: api_key=supersecret123",workspaceTrusted:true,cloudEnabled:true,cloudApproved:true});
  assert.equal(d.route,"local");
  assert.equal(d.task,"coding");
  assert.ok(d.reasons.includes("credential"));
});
test("attachments are inspected", () => {
  const d = classifyInput({prompt:"Summarize",attachments:[{path:"contract.pdf",content:"confidential customer records"}],workspaceTrusted:true});
  assert.equal(d.sensitivity,"sensitive");
});
test("unknown attachment is not cleared for cloud", () => {
  const d = classifyInput({prompt:"Review",attachments:[{path:"unknown.pdf"}],workspaceTrusted:true});
  assert.equal(d.route,"local");
  assert.ok(d.reasons.includes("unscanned-attachment"));
});
test("plain coding is not automatically cloud-safe", () => {
  assert.equal(classify("Write JUnit tests").route,"local");
});
test("restricted paths remain local", () => {
  const d=classifyInput({prompt:"Debug",attachments:[{path:".env",content:"test"}],workspaceTrusted:true});
  assert.ok(d.reasons.includes("restricted-path"));
});

test("explicit cloud approval does not bypass conservative classification", () => {
  const d = classifyInput({
    prompt: "Explain a Java method",
    workspaceTrusted: true,
    cloudEnabled: true,
    cloudApproved: true,
  });
  assert.equal(d.sensitivity, "uncertain");
  assert.equal(d.route, "local");
  assert.ok(d.reasons.includes("unverified-sensitivity"));
});
