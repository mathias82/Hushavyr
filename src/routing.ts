import {createHash, randomUUID} from "node:crypto";
import {classifyInput} from "./classifier";
import {validateContext} from "./context";
import {AuditEvent} from "./audit";
import {guardedCloudTransfer} from "./cloudTransfer";

export interface RoutingPolicy {
  mode: "local-only" | "hybrid-public-prompts";
  trusted: boolean;
  isolatedPublicWindow: boolean;
  mandatoryLocalOnly: boolean;
  requireReviewer: boolean;
}
export interface RoutePlan {route: "local" | "copilot-candidate"; reason: string}
const complex = /\b(design|architect(?:ure)?|compare|refactor|debug|review|implement|generate|build|create)\b|σχεδ[ίι]ασ|αρχιτεκτον|σ[ύυ]γκριν|δι[όο]ρθωσ|υλοπο[ίι]ησ|δημιο[ύυ]ργ|φτι[άα]ξ|αν[άα]λυσ/iu;
export function planRoute(prompt: string, policy: RoutingPolicy): RoutePlan {
  const local = (reason: string): RoutePlan => ({route: "local", reason});
  const classification = classifyInput({prompt, workspaceTrusted: policy.trusted});
  if (!prompt.trim()) return local("empty-prompt");
  if (classification.sensitivity === "sensitive" || classification.reasons.some(r => r !== "unverified-sensitivity")) return local("sensitive-or-untrusted");
  if (policy.mode !== "hybrid-public-prompts" || policy.mandatoryLocalOnly) return local("local-only-policy");
  if (policy.requireReviewer) return local("verified-reviewer-unavailable");
  if (!policy.isolatedPublicWindow) return local("project-context-must-stay-local");
  if (!complex.test(prompt)) return local("simple-task");
  // This is eligibility for a public-content review, never proof that the prompt is public.
  return {route: "copilot-candidate", reason: "complex-task-awaiting-public-approval"};
}
export interface PublicModel {id: string; label: string; send(exactPrompt: string): Promise<string>}
export interface RouterDependencies {
  policy(): RoutingPolicy;
  cancelled(): boolean;
  local(prompt: string): Promise<string>;
  pickCopilot(): Promise<PublicModel | undefined>;
  confirmPublic(exactPrompt: string, modelLabel: string): Promise<boolean>;
  audit(event: AuditEvent): Promise<unknown>;
}
export interface RoutedResult {
  provider: "ollama" | "copilot" | "none";
  reason: string;
  text?: string;
}
export function publicPayload(prompt: string): string {
  return "Answer only the explicitly supplied public prompt below. No workspace, files, history, tools or execution results are supplied. Do not claim to have read files or run tests.\n\nPUBLIC PROMPT:\n" + prompt;
}
export async function runRoutedPrompt(prompt: string, deps: RouterDependencies): Promise<RoutedResult> {
  validateContext(prompt, []);
  if (deps.cancelled()) return {provider: "none", reason: "cancelled"};
  const plan = planRoute(prompt, deps.policy());
  if (plan.route === "local") {
    const text = await deps.local(prompt);
    return deps.cancelled() ? {provider: "none", reason: "cancelled"} : {provider: "ollama", reason: plan.reason, text};
  }
  const model = await deps.pickCopilot();
  if (!model || deps.cancelled()) return {provider: "none", reason: "no-model-or-cancelled"};
  const id = "id-" + createHash("sha256").update(model.id).digest("hex");
  const auditBase = {actorId: "local-user", provider: "github-copilot", model: id,
    requestId: randomUUID(), policyVersion: "hybrid-v1"};
  const payload = publicPayload(prompt); // immutable exact snapshot; preview and send use this same string
  if (!await deps.confirmPublic(payload, model.label) || deps.cancelled()) {
    await deps.audit({...auditBase, action: "cloud-cancelled", outcome: "cancelled", reasonCode: "public-approval-cancelled"});
    return {provider: "none", reason: "public-approval-cancelled"};
  }
  if (planRoute(prompt, deps.policy()).route !== "copilot-candidate") {
    await deps.audit({...auditBase, action: "cloud-denial", outcome: "denied", reasonCode: "policy-changed"});
    return {provider: "none", reason: "policy-changed"};
  }
  let text: string | undefined;
  const result = await guardedCloudTransfer(
    {prompt: payload, workspaceTrusted: true},
    {cloudEnabled: true, allowOverrides: true},
    {reason: "User explicitly reviewed and approved this exact public prompt", confirmedCloudTransfer: true},
    {actorId: "local-user", provider: "github-copilot", model: id}, deps.audit,
    async snapshot => {
      if (deps.cancelled() || planRoute(prompt, deps.policy()).route !== "copilot-candidate") throw new Error("Policy changed");
      text = await model.send(snapshot.prompt);
      return {};
    }, deps.cancelled
  );
  if (deps.cancelled()) return {provider: "none", reason: "cancelled"};
  return result.outcome === "sent" ? {provider: "copilot", reason: "explicit-public-approval", text}
    : {provider: "none", reason: result.outcome};
}
