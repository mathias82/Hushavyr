export type Route = "local" | "cloud-eligible" | "blocked";
export type Sensitivity = "sensitive" | "uncertain" | "public";
export type Task = "coding" | "document" | "general";
export interface ClassificationInput {
  prompt: string;
  attachments?: Array<{ path: string; content?: string; label?: "public" | "internal" | "confidential" }>;
  workspaceTrusted?: boolean;
  cloudEnabled?: boolean;
  cloudApproved?: boolean;
}
export interface Decision { route: Route; sensitivity: Sensitivity; task: Task; reasons: string[] }

const sensitive: Array<[string, RegExp]> = [
  ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i],
  ["credential", /\b(?:api[_-]?key|password|client[_-]?secret|access[_-]?token)\s*[:=]\s*["']?[^\s"']{4,}/i],
  ["confidential-marker", /\b(?:confidential|strictly private|internal only|εμπιστευτικ[όά])\b/i],
  ["personal-data-hint", /\b(?:customer records|employee records|personal data|προσωπικά δεδομένα)\b/i],
];
const restrictedPath = /(?:^|\/)(?:\.env(?:\..*)?|secrets?\b|credentials?\b)|\.(?:p12|pfx|pem|key)$/i;
const coding = /\b(?:java|spring|junit|unit tests?|refactor|debug|function|class|typescript|python|compile)\b/i;
const document = /\b(?:pdf|document|contract|invoice|report|σύμβαση|έγγραφο)\b/i;

/** Conservative classifier: absence of a match is not proof of public data. */
export function classifyInput(input: ClassificationInput): Decision {
  const reasons: string[] = [];
  const attachments = input.attachments ?? [];
  const combined = [input.prompt, ...attachments.map(a => a.content ?? "")].join("\n");
  const task: Task = coding.test(input.prompt) ? "coding" : document.test(input.prompt) ? "document" : "general";
  for (const [name, regex] of sensitive) if (regex.test(combined)) reasons.push(name);
  for (const attachment of attachments) {
    if (restrictedPath.test(attachment.path)) reasons.push("restricted-path");
    if (attachment.label === "internal" || attachment.label === "confidential") reasons.push("restricted-label");
    if (attachment.content === undefined) reasons.push("unscanned-attachment");
  }
  if (input.workspaceTrusted !== true) reasons.push("untrusted-workspace");
  if (!input.prompt.trim() && attachments.length === 0) reasons.push("empty-context");
  const definitelySensitive = reasons.some(r => !["untrusted-workspace", "empty-context", "unscanned-attachment"].includes(r));
  const sensitivity: Sensitivity = definitelySensitive ? "sensitive" : "uncertain";
  if (reasons.length === 0) reasons.push("unverified-sensitivity");
  if (input.cloudEnabled && input.cloudApproved && sensitivity === "public") {
    return { route: "cloud-eligible", sensitivity, task, reasons };
  }
  return { route: "local", sensitivity, task, reasons };
}

/** Backward-compatible wrapper. */
export function classify(text: string): Decision {
  return classifyInput({ prompt: text });
}
