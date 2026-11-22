import { test } from "node:test";
import { strict as assert } from "node:assert";
import { classify } from "../../escalation/classifier";

test("secrets are routed locally", () => {
  const decision = classify("api_key=supersecret123");
  assert.equal(decision.route, "local");
  assert.ok(decision.reasons.includes("credential"));
});

test("unknown content fails closed", () => {
  assert.equal(classify("Write JUnit tests").route, "local");
});
