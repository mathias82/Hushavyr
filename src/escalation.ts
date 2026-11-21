import {createHash, randomUUID} from "node:crypto";
import {classifyInput} from "./classifier";
import {scanSecrets} from "./secretsScan";
import {AuditEvent} from "./audit";
import {guardedCloudTransfer} from "./cloudTransfer";
import {PublicModel} from "./routing";

export const MAX_ESCALATION_CHARS = 4000;
const KEYWORDS = new Set(("abstract and as assert async await boolean break byte case catch char class const continue def default del do " +
  "double elif else enum except export extends false final finally float for from function func go if implements import in instanceof " +
  "int interface is lambda let long new nil none not null or package pass private protected public raise return self short static " +
  "string super switch synchronized this throw throws true try type typeof undefined var void volatile while with yield " +
  "None True False String Integer Long Boolean Object List Map Set Optional Exception RuntimeException Override console print len range str dict list " +
  "Math JSON Promise Array Error Date Number").split(" "));

export interface Pseudonymized {text: string; map: Map<string, string>}

/** Replaces comments, string literals and project identifiers with neutral tokens; the reverse map never leaves the device. */
export function pseudonymize(code: string): Pseudonymized {
  const map = new Map<string, string>(), seen = new Map<string, string>();
  let ids = 0, strs = 0;
  const token = (original: string, make: () => string): string => {
    const existing = seen.get(original);
    if (existing) return existing;
    const next = make();
    seen.set(original, next); map.set(next, original);
    return next;
  };
  const text = code.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|#[^\n]*|("(?:[^"\x5c\n]|\x5c.)*"|'(?:[^'\x5c\n]|\x5c.)*'|`(?:[^`\x5c]|\x5c.)*`)|\b[A-Za-z_$][\w$]*\b/g, (m, str) => {
    if (str) return str[0] + token(str, () => "s" + ++strs) + str[0];
    if (m.startsWith("//") || m.startsWith("/*") || m.startsWith("#")) return "";
    if (KEYWORDS.has(m) || /^(?:get|set|add|put|close|open|query|execute|exec|eval|run|read|write|send|parse|format|equals|hashCode|toString|length|size|map|filter|push|join|split|replace|trim|append|apply|call|bind|then|catch|log|info|warn|error|debug)$/.test(m)) return m;
    return token(m, () => "id" + ++ids);
  });
  return {text: text.replace(/[ \t]+$/gm, ""), map};
}

export function restore(text: string, map: Map<string, string>): string {
  return text.replace(/\b(?:id|s)\d+\b/g, t => {
    const original = map.get(t);
    return original === undefined ? t : t.startsWith("s") ? original.slice(1, -1) : original;
  });
}

export interface EscalationInput {path: string; code: string; question: string; localOnly: boolean; ignored: boolean}
/** Returns why a snippet must stay local, or undefined when it may be offered for approval. */
export function escalationBlock(input: EscalationInput): string | undefined {
  if (input.localOnly) return "this workspace is local-only";
  if (input.ignored) return "the file is listed in .hushavyr/ignore";
  if (!input.code.trim()) return "select the function to escalate";
  if (input.code.length > MAX_ESCALATION_CHARS) return "the selection exceeds " + MAX_ESCALATION_CHARS + " characters; select one function";
  if (scanSecrets(input.code).length) return "a possible secret is in the selection";
  const decision = classifyInput({prompt: input.question, selectedCode: [{path: input.path, content: input.code}], workspaceTrusted: true});
  const reasons = decision.reasons.filter(r => r !== "unverified-sensitivity");
  return reasons.length ? "sensitive content detected (" + reasons.join(", ") + ")" : undefined;
}

export function escalationPayload(question: string, pseudoCode: string): string {
  return "You review an isolated, pseudonymized code fragment. Identifiers are idN and string literals are sN on purpose; keep these tokens unchanged in your answer. " +
    "No other files, history or tools are available. Answer the question, name concrete defects with severity and give a corrected fragment.\n\n" +
    "QUESTION:\n" + (question.trim() || "Find bugs and security issues in this fragment.") + "\n\nFRAGMENT:\n" + pseudoCode;
}

export interface EscalationDeps {
  pickModel(): Promise<PublicModel | undefined>;
  confirm(payload: string, modelLabel: string): Promise<boolean>;
  audit(event: AuditEvent): Promise<unknown>;
  cancelled(): boolean;
}
export interface EscalationResult {outcome: "blocked" | "cancelled" | "denied" | "failed" | "sent"; reason?: string; text?: string}

export async function escalate(input: EscalationInput, deps: EscalationDeps): Promise<EscalationResult> {
  const blocked = escalationBlock(input);
  if (blocked) return {outcome: "blocked", reason: blocked};
  const pseudo = pseudonymize(input.code);
  // Names from the code that the user repeats in the question are replaced by the same tokens.
  const tokenOf = new Map([...pseudo.map].filter(([t]) => t.startsWith("id")).map(([t, original]) => [original, t]));
  const question = input.question.replace(/\b[A-Za-z_$][\w$]*\b/g, w => tokenOf.get(w) ?? w);
  const payload = escalationPayload(question, pseudo.text);
  // The outgoing text itself is checked again, so a leak through the question is also caught.
  const recheck = classifyInput({prompt: payload, workspaceTrusted: true}).reasons.filter(r => r !== "unverified-sensitivity");
  if (recheck.length || scanSecrets(payload).length) return {outcome: "blocked", reason: "the outgoing payload still looks sensitive"};
  const model = await deps.pickModel();
  if (!model || deps.cancelled()) return {outcome: "cancelled", reason: "no model chosen"};
  const id = "id-" + createHash("sha256").update(model.id).digest("hex");
  if (!await deps.confirm(payload, model.label) || deps.cancelled()) {
    await deps.audit({actorId: "local-user", provider: "github-copilot", model: id, requestId: randomUUID(), policyVersion: "escalation-v1",
      action: "cloud-cancelled", outcome: "cancelled", reasonCode: "public-approval-cancelled"});
    return {outcome: "cancelled", reason: "not approved"};
  }
  let text = "";
  const receipt = await guardedCloudTransfer({prompt: payload, workspaceTrusted: true}, {cloudEnabled: true, allowOverrides: true, mandatoryLocalOnly: input.localOnly},
    {reason: "User approved this exact pseudonymized fragment", confirmedCloudTransfer: true},
    {actorId: "local-user", provider: "github-copilot", model: id}, deps.audit,
    async snapshot => { text = await model.send(snapshot.prompt); return {}; }, deps.cancelled);
  return receipt.outcome === "sent" ? {outcome: "sent", text: restore(text, pseudo.map)} : {outcome: receipt.outcome};
}
