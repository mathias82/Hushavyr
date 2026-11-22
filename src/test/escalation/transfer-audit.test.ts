import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, stat, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditEvent, makeAuditRecord, writeAuditEvent, writeRetainedAuditEvent } from "../../escalation/audit";
import { guardedCloudTransfer } from "../../escalation/cloudTransfer";
import { reviewOverride, OverrideUI } from "../../escalation/overrideFlow";
const input = {prompt: "Explain this public sample", workspaceTrusted: true};
const policy = {cloudEnabled: true, allowOverrides: true};
const approval = {reason: "Reviewed public synthetic example", confirmedCloudTransfer: true};
const metadata = {actorId: "user-1", provider: "test-provider", model: "test-model"};
const event: AuditEvent = {...metadata, action: "cloud-approval", outcome: "approved", requestId: "request-1", policyVersion: "v2", reasonCode: "manual-review"};
const ui: OverrideUI = {confirmWarning: async () => true, justification: async () => approval.reason, confirmReview: async () => true};

test("audit rejects hidden runtime payload properties and invalid event pairs", () => {
  assert.throws(() => makeAuditRecord({...event, prompt: "secret"} as AuditEvent));
  assert.throws(() => makeAuditRecord({...event, outcome: "sent"}));
  assert.throws(() => makeAuditRecord({...event, tokenCount: -1}));
  assert.throws(() => makeAuditRecord({...event, action: "unknown" as AuditEvent["action"]}));
});
test("audit corrects existing permissions, rejects symlinks and retains only recent daily segments", async () => {
  const dir = await mkdtemp(join(tmpdir(), "router-audit-"));
  try {
    const file = join(dir, "events.jsonl");
    await writeFile(file, "", {mode: 0o666});
    await writeAuditEvent(file, event);
    if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600);
    await symlink(file, join(dir, "link.jsonl"));
    await assert.rejects(writeAuditEvent(join(dir, "link.jsonl"), event));
    await writeFile(join(dir, "cloud-review.2020-01-01.jsonl"), "old");
    await writeFile(join(dir, "unrelated.jsonl"), "keep");
    await writeRetainedAuditEvent(dir, event, 30, new Date("2026-11-16T12:00:00Z"));
    await assert.rejects(stat(join(dir, "cloud-review.2020-01-01.jsonl")));
    assert.equal(await readFile(join(dir, "unrelated.jsonl"), "utf8"), "keep");
    const lines = (await readFile(join(dir, "events.jsonl"), "utf8")).trim().split('\n');
    assert.equal(lines.length, 1);
  } finally { await rm(dir, {recursive: true, force: true}); }
});
test("dispatch logs approval, attempted and sent with one correlation ID and counts only", async () => {
  const events: AuditEvent[] = [];
  let calls = 0;
  const receipt = await guardedCloudTransfer(input, policy, approval, metadata,
    async e => {events.push(e);}, async () => {calls++; assert.equal(events.at(-1)?.outcome, "attempted"); return {tokenCount: 42};});
  assert.equal(receipt.outcome, "sent");
  assert.equal(calls, 1);
  assert.deepEqual(events.map(e => e.outcome), ["approved", "attempted", "sent"]);
  assert.equal(new Set(events.map(e => e.requestId)).size, 1);
  assert.equal(events[2].tokenCount, 42);
  assert.doesNotMatch(JSON.stringify(events), /Explain this public|Reviewed public/);
});
test("audit failure before approval or dispatch never invokes transport", async () => {
  for (const failureAt of [1, 2]) {
    let writes = 0, calls = 0;
    await assert.rejects(guardedCloudTransfer(input, policy, approval, metadata,
      async () => {if (++writes === failureAt) throw new Error("disk full");}, async () => {calls++; return {}; }));
    assert.equal(calls, 0);
  }
});
test("denied, cancelled and failed transfers produce separate safe audit outcomes", async () => {
  for (const scenario of ["denied", "cancelled", "failed"] as const) {
    const events: AuditEvent[] = [];
    let calls = 0;
    const receipt = await guardedCloudTransfer(input, scenario === "denied" ? {...policy, mandatoryLocalOnly: true} : policy,
      approval, metadata, async e => {events.push(e);}, async () => {calls++; throw new Error("raw provider secret");}, () => scenario === "cancelled");
    assert.equal(receipt.outcome, scenario);
    assert.equal(events.at(-1)?.outcome, scenario);
    assert.equal(calls, scenario === "failed" ? 1 : 0);
    assert.doesNotMatch(JSON.stringify(events), /raw provider secret/);
  }
});
test("post-send audit failure propagates without sending twice", async () => {
  let calls = 0, writes = 0;
  await assert.rejects(guardedCloudTransfer(input, policy, approval, metadata,
    async () => {if (++writes === 3) throw new Error("disk full");}, async () => {calls++; return {}; }));
  assert.equal(calls, 1);
});
test("dispatch receives scanned snapshot even when original input changes", async () => {
  const original = {...input};
  await guardedCloudTransfer(original, policy, approval, metadata,
    async () => {original.prompt = "password=synthetic-secret";}, async snapshot => {
      assert.equal(snapshot.prompt, input.prompt); return {};
    });
});
test("override cancellation at every UI step is audited and defaults to deny", async () => {
  for (const change of [{confirmWarning: async () => false}, {justification: async () => undefined}, {confirmReview: async () => false}]) {
    const events: AuditEvent[] = [];
    assert.equal(await reviewOverride(input, policy, {...ui, ...change}, async e => {events.push(e);}), "cancelled");
    assert.deepEqual(events.map(e => e.outcome), ["cancelled"]);
  }
});
test("override denies mandatory policy, unverified reviewer and sensitive context", async () => {
  for (const [candidate, p] of [[input, {...policy, mandatoryLocalOnly: true}], [input, {...policy, requireReviewer: true}],
    [{...input, toolOutputs: [{path: "result", content: "password=synthetic-secret"}]}, policy]] as const) {
    const events: AuditEvent[] = [];
    assert.equal(await reviewOverride(candidate, p, ui, async e => {events.push(e);}), "denied");
    assert.equal(events[0].outcome, "denied");
  }
});
test("review approval requires durable audit and records reviewer approval type", async () => {
  await assert.rejects(reviewOverride(input, policy, ui, async () => {throw new Error("disk full");}));
  const events: AuditEvent[] = [];
  assert.equal(await reviewOverride(input, {...policy, requireReviewer: true}, {...ui, reviewerApproval: async () => true}, async e => {events.push(e);}), "approved");
  assert.equal(events[0].approvalType, "reviewer");
});
