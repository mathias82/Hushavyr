import { test } from "node:test";
import { strict as assert } from "node:assert";
import { classifyInput } from "../../escalation/classifier";
import { requestCloudOverride } from "../../escalation/override";
const policy = { cloudEnabled: true, allowOverrides: true };
const approval = { reason: "Reviewed and verified that this document is public", confirmedCloudTransfer: true };
for (const [label, value] of [
  ["email", "Contact jane@example.com"],
  ["AFM", "ΑΦΜ: 123456789"],
  ["AMKA", "ΑΜΚΑ: 12345678901"],
  ["IBAN", "IBAN GR1601101250000000012300695"],
  ["phone", "phone: +30 691 234 5678"],
] as const) {
  test(label + " in attachment is local-only and override denied", () => {
    const input = { prompt: "Review this Java code", workspaceTrusted: true, attachments: [{ path: "sample.txt", content: value }] };
    const decision = classifyInput(input);
    assert.equal(decision.route, "local");
    assert.equal(decision.sensitivity, "sensitive");
    assert.equal(requestCloudOverride(input, policy, approval).allowed, false);
  });
}
test("unverified content still stays local", () => {
  assert.equal(classifyInput({ prompt: "Write a public function", workspaceTrusted: true }).route, "local");
});
