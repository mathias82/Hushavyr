import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export type AuditAction = "cloud-approval" | "cloud-dispatch" | "cloud-denial" | "cloud-failure";
export interface AuditEvent {
  action: AuditAction;
  actorId: string;
  provider: string;
  model: string;
  requestId: string;
  policyVersion: string;
  reasonCode: string;
  approvalId?: string;
  tokenCount?: number;
  outcome: "approved" | "denied" | "sent" | "failed";
}
export interface AuditRecord extends AuditEvent {
  eventId: string;
  timestampUtc: string;
}
const identifier = /^[a-zA-Z0-9._:@-]{1,128}$/;
const reason = /^[a-z0-9-]{1,64}$/;
/** Strict allowlisting prevents raw prompts, credentials and arbitrary text from reaching audit logs. */
export function makeAuditRecord(event: AuditEvent): AuditRecord {
  for (const key of ["actorId", "provider", "model", "requestId", "policyVersion"] as const) {
    if (!identifier.test(event[key])) throw new Error("Invalid audit metadata: " + key);
  }
  if (!reason.test(event.reasonCode)) throw new Error("Use a safe reason code, not free text");
  if (event.approvalId !== undefined && !identifier.test(event.approvalId)) throw new Error("Invalid approvalId");
  if (event.tokenCount !== undefined && (!Number.isSafeInteger(event.tokenCount) || event.tokenCount < 0)) throw new Error("Invalid token count");
  return { ...event, eventId: randomUUID(), timestampUtc: new Date().toISOString() };
}
export async function writeAuditEvent(path: string, event: AuditEvent): Promise<AuditRecord> {
  const record = makeAuditRecord(event);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await appendFile(path, JSON.stringify(record) + "\n", { encoding: "utf8", mode: 0o600, flag: "a" });
  return record;
}
/** Must be awaited before external dispatch. If audit fails, the caller must NOT send. */
export async function auditBeforeCloudDispatch(path: string, event: AuditEvent): Promise<void> {
  if (event.action !== "cloud-approval" || event.outcome !== "approved") throw new Error("Expected approved cloud transfer");
  await writeAuditEvent(path, event);
}
