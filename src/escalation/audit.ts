import { constants } from "node:fs";
import { mkdir, open, readdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export type AuditAction = "cloud-approval" | "cloud-dispatch" | "cloud-denial" | "cloud-failure" | "cloud-cancelled";
export interface AuditEvent {
  action: AuditAction;
  actorId: string;
  provider: string;
  model: string;
  requestId: string;
  policyVersion: string;
  reasonCode: string;
  approvalId?: string;
  approvalType?: "manual" | "reviewer";
  tokenCount?: number;
  outcome: "approved" | "denied" | "attempted" | "sent" | "failed" | "cancelled";
}
export interface AuditRecord extends AuditEvent { eventId: string; timestampUtc: string }
const identifier = /^[a-zA-Z0-9._:@-]{1,128}$/;
const reason = /^[a-z0-9-]{1,64}$/;
const keys = new Set(["action", "actorId", "provider", "model", "requestId", "policyVersion", "reasonCode", "approvalId", "approvalType", "tokenCount", "outcome"]);
const outcomes: Record<AuditAction, readonly string[]> = {
  "cloud-approval": ["approved"], "cloud-dispatch": ["attempted", "sent"], "cloud-denial": ["denied"],
  "cloud-failure": ["failed"], "cloud-cancelled": ["cancelled"]
};
/** Reject unexpected runtime properties instead of spreading secrets into a log. */
export function makeAuditRecord(event: AuditEvent): AuditRecord {
  if (Object.keys(event).some(key => !keys.has(key))) throw new Error("Unexpected audit field");
  if (!Object.hasOwn(outcomes, event.action) || !outcomes[event.action].includes(event.outcome)) throw new Error("Invalid audit action/outcome");
  for (const key of ["actorId", "provider", "model", "requestId", "policyVersion"] as const) {
    if (typeof event[key] !== "string" || !identifier.test(event[key])) throw new Error("Invalid audit metadata: " + key);
  }
  if (typeof event.reasonCode !== "string" || !reason.test(event.reasonCode)) throw new Error("Use a safe reason code, not free text");
  if (event.approvalId !== undefined && !identifier.test(event.approvalId)) throw new Error("Invalid approvalId");
  if (event.approvalType !== undefined && !["manual", "reviewer"].includes(event.approvalType)) throw new Error("Invalid approval type");
  if (event.tokenCount !== undefined && (!Number.isSafeInteger(event.tokenCount) || event.tokenCount < 0)) throw new Error("Invalid token count");
  return {...event, eventId: randomUUID(), timestampUtc: new Date().toISOString()};
}
export async function writeAuditEvent(path: string, event: AuditEvent): Promise<AuditRecord> {
  const record = makeAuditRecord(event);
  await mkdir(dirname(path), {recursive: true, mode: 0o700});
  const file = await open(path, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    await file.chmod(0o600);
    await file.writeFile(JSON.stringify(record) + "\n", "utf8");
  } finally { await file.close(); }
  return record;
}
/** Must be awaited before external dispatch. A write failure prevents dispatch. */
export async function auditBeforeCloudDispatch(path: string, event: AuditEvent): Promise<void> {
  if (event.action !== "cloud-approval" || event.outcome !== "approved") throw new Error("Expected approved cloud transfer");
  await writeAuditEvent(path, event);
}
/** Daily append-only segments. Retention removes old segments, never edits event lines. */
export async function writeRetainedAuditEvent(directory: string, event: AuditEvent, retentionDays = 30, now = new Date()): Promise<AuditRecord> {
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 365) throw new Error("Invalid audit retention");
  const day = now.toISOString().slice(0, 10);
  const record = await writeAuditEvent(join(directory, "cloud-review." + day + ".jsonl"), event);
  const cutoff = new Date(now.getTime() - retentionDays * 86400000).toISOString().slice(0, 10);
  for (const name of await readdir(directory)) {
    const match = /^cloud-review\.(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
    if (match && match[1] < cutoff) await unlink(join(directory, name)).catch(error => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  return record;
}
