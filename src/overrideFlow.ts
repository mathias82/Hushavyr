import { randomUUID } from "node:crypto";
import { AuditEvent } from "./audit";
import { ClassificationInput } from "./classifier";
import { OverridePolicy, requestCloudOverride } from "./override";

export interface OverrideUI {
  confirmWarning(): Promise<boolean>;
  justification(): Promise<string | undefined>;
  confirmReview(): Promise<boolean>;
  reviewerApproval?(): Promise<boolean>;
}
/** Review-only workflow. No dispatch callback exists here. */
export async function reviewOverride(
  input: ClassificationInput, policy: OverridePolicy, ui: OverrideUI,
  audit: (event: AuditEvent) => Promise<unknown>
): Promise<"approved" | "denied" | "cancelled"> {
  const snapshot = structuredClone(input);
  const requestId = randomUUID(), approvalId = randomUUID();
  const base = {actorId: "local-user", provider: "anthropic", model: "sonnet", requestId, approvalId, policyVersion: "v2"};
  const cancel = async (): Promise<"cancelled"> => {
    await audit({...base, action: "cloud-cancelled", outcome: "cancelled", reasonCode: "user-cancelled"});
    return "cancelled";
  };
  if (!await ui.confirmWarning()) return cancel();
  const reason = await ui.justification();
  if (reason === undefined) return cancel();
  if (!await ui.confirmReview()) return cancel();
  const reviewerApproved = policy.requireReviewer ? await ui.reviewerApproval?.() === true : false;
  const result = requestCloudOverride(snapshot, policy, {reason, confirmedCloudTransfer: true, reviewerApproved});
  await audit({...base, approvalType: reviewerApproved ? "reviewer" : "manual",
    action: result.allowed ? "cloud-approval" : "cloud-denial",
    outcome: result.allowed ? "approved" : "denied",
    reasonCode: result.allowed ? "manual-review" : "policy-denied"});
  return result.allowed ? "approved" : "denied";
}
