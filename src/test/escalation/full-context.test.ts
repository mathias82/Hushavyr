import { test } from "node:test";
import { strict as assert } from "node:assert";
import { ClassificationInput, classifyInput } from "../../escalation/classifier";
import { requestCloudOverride } from "../../escalation/override";
const policy = {cloudEnabled: true, allowOverrides: true};
const approval = {reason: "Reviewed synthetic public example", confirmedCloudTransfer: true};
for (const contextKey of ["attachments", "selectedCode", "toolOutputs", "retrievedContext"] as const) {
  test("inspects sensitive and unscanned " + contextKey, () => {
    for (const content of ["password=synthetic-token", "Εμπιστευτικό έγγραφο", "email: synthetic@example.test", undefined]) {
      const input: ClassificationInput = {prompt: "Review Java", workspaceTrusted: true,
        [contextKey]: [{path: "public.txt", content, label: "public"}]};
      assert.equal(classifyInput(input).route, "local");
      assert.equal(requestCloudOverride(input, policy, approval).allowed, false);
    }
  });
}
test("restricted Windows paths and labels deny override", () => {
  for (const part of [{path: 'C:\\project\\.env', content: "test"}, {path: "sample.txt", content: "test", label: "internal" as const}]) {
    assert.equal(requestCloudOverride({prompt: "Review", retrievedContext: [part], workspaceTrusted: true}, policy, approval).allowed, false);
  }
});
test("benign samples do not claim PII but remain uncertain and local", () => {
  for (const prompt of ['public class Account {}', 'SELECT id FROM examples', 'The word password has no value']) {
    const decision = classifyInput({prompt, workspaceTrusted: true});
    assert.equal(decision.sensitivity, "uncertain");
    assert.equal(decision.route, "local");
    assert.deepEqual(decision.reasons, ["unverified-sensitivity"]);
  }
});
