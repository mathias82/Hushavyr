import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditBeforeCloudDispatch, makeAuditRecord } from "../audit";

const event = {
  action: "cloud-approval" as const,
  actorId: "developer-1",
  provider: "anthropic",
  model: "sonnet",
  requestId: "req-1",
  policyVersion: "v1",
  reasonCode: "reviewed-public-content",
  outcome: "approved" as const,
};
test("audit writes metadata without prompt or credentials", async () => {
  const dir = await mkdtemp(join(tmpdir(), "privacy-audit-"));
  try {
    const path = join(dir, "audit.jsonl");
    await auditBeforeCloudDispatch(path, event);
    const stored = JSON.parse(await readFile(path, "utf8"));
    assert.equal(stored.actorId, "developer-1");
    assert.ok(stored.timestampUtc);
    assert.equal(stored.action, "cloud-approval");
    assert.equal(stored.prompt, undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("rejects free-text reason that could leak secrets", () => {
  assert.throws(() => makeAuditRecord({ ...event, reasonCode: "My token is abc secret" }));
});
test("rejects arbitrary metadata", () => {
  assert.throws(() => makeAuditRecord({ ...event, model: "sonnet\npassword=abc" }));
});
test("fails closed if audit cannot be written", async () => {
  await assert.rejects(auditBeforeCloudDispatch("/dev/null/audit.jsonl", event));
});
test("denial cannot be recorded as approval", async () => {
  await assert.rejects(auditBeforeCloudDispatch("/tmp/unused.jsonl", { ...event, outcome: "denied" }));
});
