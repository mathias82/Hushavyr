import { randomUUID } from "node:crypto";
import { AuditEvent } from "./audit";
import { ClassificationInput } from "./classifier";
import { OverridePolicy, OverrideRequest, requestCloudOverride } from "./override";

export interface TransferMetadata { actorId: string; provider: string; model: string }
export interface TransferReceipt { outcome: "denied" | "cancelled" | "sent" | "failed"; requestId: string }
/** Future adapter boundary. The extension supplies no cloud transport in this release. */
export async function guardedCloudTransfer(
  input: ClassificationInput, policy: OverridePolicy, approval: OverrideRequest,
  metadata: TransferMetadata, audit: (event: AuditEvent) => Promise<unknown>,
  dispatch: (snapshot: ClassificationInput) => Promise<{tokenCount?: number}>,
  cancelled: () => boolean = () => false
): Promise<TransferReceipt> {
  // Policy and eventual dispatch inspect the same immutable snapshot.
  const snapshot = structuredClone(input);
  const decision = requestCloudOverride(snapshot, policy, approval);
  const requestId = randomUUID(), approvalId = randomUUID();
  const base = {...metadata, requestId, approvalId, policyVersion: "v2",
    approvalType: approval.reviewerApproved ? "reviewer" as const : "manual" as const};
  if (!decision.allowed) {
    await audit({...base, action: "cloud-denial", outcome: "denied", reasonCode: "policy-denied"});
    return {outcome: "denied", requestId};
  }
  if (cancelled()) {
    await audit({...base, action: "cloud-cancelled", outcome: "cancelled", reasonCode: "user-cancelled"});
    return {outcome: "cancelled", requestId};
  }
  await audit({...base, action: "cloud-approval", outcome: "approved", reasonCode: "manual-review"});
  await audit({...base, action: "cloud-dispatch", outcome: "attempted", reasonCode: "dispatch-start"});
  if (cancelled()) {
    await audit({...base, action: "cloud-cancelled", outcome: "cancelled", reasonCode: "user-cancelled"});
    return {outcome: "cancelled", requestId};
  }
  let receipt: {tokenCount?: number};
  try { receipt = await dispatch(snapshot); }
  catch {
    await audit({...base, action: "cloud-failure", outcome: "failed", reasonCode: "dispatch-failed"});
    return {outcome: "failed", requestId};
  }
  // If this post-dispatch write fails, propagate it. Never retry an external send.
  await audit({...base, action: "cloud-dispatch", outcome: "sent", reasonCode: "dispatch-complete", tokenCount: receipt.tokenCount});
  return {outcome: "sent", requestId};
}
