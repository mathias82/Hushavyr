import {SourceChange} from "./fixProof";

export const testSchema = {type: "object", additionalProperties: false, required: ["source"],
  properties: {source: {type: "string"}}};
export const fixSchema = {type: "object", additionalProperties: false, required: ["changes"],
  properties: {changes: {type: "array", minItems: 1, maxItems: 6, items: {
    type: "object", additionalProperties: false, required: ["path", "content"],
    properties: {path: {type: "string"}, content: {type: "string"}}
  }}}};
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid-model-output");
  return value as Record<string, unknown>;
}
export function parseTestProposal(raw: string): string {
  const proposal = object(JSON.parse(raw));
  if (typeof proposal.source !== "string" || !proposal.source.trim() ||
    Buffer.byteLength(proposal.source, "utf8") > 8000) throw new Error("invalid-test-proposal");
  return proposal.source;
}
export function parseFixProposal(raw: string): SourceChange[] {
  const proposal = object(JSON.parse(raw));
  if (!Array.isArray(proposal.changes) || !proposal.changes.length || proposal.changes.length > 6 ||
    Buffer.byteLength(raw, "utf8") > 24000) throw new Error("invalid-fix-proposal");
  return proposal.changes.map(value => {
    const item = object(value);
    if (typeof item.path !== "string" || typeof item.content !== "string") throw new Error("invalid-change");
    return {path: item.path, content: item.content};
  });
}
