export type Route = "local" | "cloud-eligible" | "blocked";
export type Sensitivity = "sensitive" | "uncertain" | "public";
export type Task = "coding" | "document" | "general";
export interface ContextPart {
  path: string;
  content?: string;
  label?: "public" | "internal" | "confidential";
}
export interface ClassificationInput {
  prompt: string;
  attachments?: readonly ContextPart[];
  selectedCode?: readonly ContextPart[];
  toolOutputs?: readonly ContextPart[];
  retrievedContext?: readonly ContextPart[];
  workspaceTrusted?: boolean;
  cloudEnabled?: boolean;
  cloudApproved?: boolean;
}
export interface Decision { route: Route; sensitivity: Sensitivity; task: Task; reasons: string[] }

const sensitive: Array<[string, RegExp]> = [
  ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i],
  ["credential", /\b(?:api[_-]?key|password|client[_-]?secret|access[_-]?token)\s*[:=]\s*["']?[^\s"']{4,}/i],
  ["confidential-marker", /\b(?:confidential|strictly private|internal only)\b|εμπιστευτικ[όά]/iu],
  ["personal-data-hint", /\b(?:customer records|employee records|personal data|προσωπικά δεδομένα)\b/i],
];
const piiPatterns: Array<[string, RegExp]> = [
  ["email-address", /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i],
  ["greek-afm-labeled", /(?:ΑΦΜ|AFM|tax\s*id)\s*[:#=-]?\s*\d{9}\b/i],
  ["greek-amka-labeled", /(?:ΑΜΚΑ|AMKA)\s*[:#=-]?\s*\d{11}\b/i],
  ["iban", /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){11,30}\b/i],
  ["phone-labeled", /(?:phone|mobile|τηλέφωνο|κινητό)\s*[:#=-]?\s*\+?\d[\d\s()-]{7,}\d/i],
];
const restrictedPath = /(?:^|\/)(?:\.env(?:\..*)?|secrets?\b|credentials?\b)|\.(?:p12|pfx|pem|key)$/i;
const coding = /\b(?:java|spring|junit|unit tests?|refactor|debug|function|class|typescript|python|compile)\b/i;
const document = /\b(?:pdf|document|contract|invoice|report|σύμβαση|έγγραφο)\b/i;

/** Conservative classifier: absence of a match is not proof of public data. */
export function classifyInput(input: ClassificationInput): Decision {
  const reasons: string[] = [];
  const attachments = [...(input.attachments ?? []), ...(input.selectedCode ?? []),
    ...(input.toolOutputs ?? []), ...(input.retrievedContext ?? [])];
  const combined = [input.prompt, ...attachments.map(a => a.content ?? "")].join("\n");
  const task: Task = coding.test(input.prompt) ? "coding" : document.test(input.prompt) ? "document" : "general";
  for (const [name, regex] of [...sensitive, ...piiPatterns]) if (regex.test(combined)) reasons.push(name);
  for (const attachment of attachments) {
    if (restrictedPath.test(attachment.path.replace(/\\/g, "/"))) reasons.push("restricted-path");
    if (attachment.label === "internal" || attachment.label === "confidential") reasons.push("restricted-label");
    if (typeof attachment.content !== "string") reasons.push("unscanned-attachment");
  }
  if (input.workspaceTrusted !== true) reasons.push("untrusted-workspace");
  if (!input.prompt.trim() && attachments.length === 0) reasons.push("empty-context");
  const definitelySensitive = reasons.some(r => !["untrusted-workspace", "empty-context", "unscanned-attachment"].includes(r));
  const sensitivity: Sensitivity = definitelySensitive ? "sensitive" : "uncertain";
  if (reasons.length === 0) reasons.push("unverified-sensitivity");
  // No input is classified as proven public in MVP; cloud eligibility
  // must never be inferred solely from user approval or workspace trust.
  return { route: "local", sensitivity, task, reasons };
}

/** Backward-compatible wrapper. */
export function classify(text: string): Decision {
  return classifyInput({ prompt: text });
}

