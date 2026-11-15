import { classifyInput, type ClassificationInput, type Decision } from "./classifier";

export interface OverrideRequest {
  reason: string;
  confirmedCloudTransfer: boolean;
  reviewerApproved?: boolean;
}
export interface OverridePolicy {
  cloudEnabled: boolean;
  allowOverrides: boolean;
  mandatoryLocalOnly?: boolean;
  requireReviewer?: boolean;
}
export interface OverrideResult {
  decision: Decision;
  allowed: boolean;
  reasons: string[];
}

/** Authorization gate. UI confirmation is never sufficient on its own. */
export function requestCloudOverride(input: ClassificationInput, policy: OverridePolicy, request: OverrideRequest): OverrideResult {
  const decision = classifyInput(input);
  const reasons: string[] = [];
  if (!policy.cloudEnabled) reasons.push("cloud-disabled");
  if (!policy.allowOverrides) reasons.push("overrides-disabled");
  if (policy.mandatoryLocalOnly) reasons.push("mandatory-local-only");
  if (!request.confirmedCloudTransfer) reasons.push("cloud-transfer-not-confirmed");
  if (request.reason.trim().length < 15) reasons.push("insufficient-justification");
  if (policy.requireReviewer && !request.reviewerApproved) reasons.push("reviewer-approval-required");
  if (decision.reasons.some(r => ["private-key", "credential", "restricted-path", "restricted-label", "unscanned-attachment"].includes(r))) {
    reasons.push("non-overridable-risk");
  }
  // A heuristic classifier cannot establish that personal data is absent.
  // Human override is permitted only for explicit false-positive review of
  // lower-risk content and is NOT a security certification.
  if (reasons.length) return { decision, allowed: false, reasons };
  return {
    decision: { ...decision, route: "cloud-eligible", reasons: [...decision.reasons, "human-override"] },
    allowed: true,
    reasons: ["human-override"]
  };
}
