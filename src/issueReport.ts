// Pure, testable parts of the opt-in issue report; no VS Code API and no I/O.
export interface ReportInfo {
  extension: string; vscode: string; os: string; memoryGb: number;
  settings: Record<string, unknown>; tools: Record<string, boolean>; problem: string;
}

/** Settings are reduced to non-identifying shapes: no endpoints, paths, hosts or free text leave the machine. */
export function redactSettings(settings: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(settings)) {
    if (key === "ollamaEndpoint") {
      const host = typeof value === "string" ? /^\w+:\/\/([^/:]+)/.exec(value)?.[1] ?? "" : "";
      out[key] = /^(localhost|127\.0\.0\.1|\[?::1\]?)$/.test(host) ? "loopback" : value ? "non-loopback" : "unset";
    } else if (/cache/i.test(key)) out[key] = value ? "set" : "default";
    else if (typeof value === "boolean" || typeof value === "number") out[key] = value;
    // Model/image names are public identifiers; a registry host in front of them could name a company.
    else if (typeof value === "string") out[key] = !/^[\w.:\-/]{1,80}$/.test(value) || /^[/.~]/.test(value) ? "custom" : /^[^/]*[.:][^/]*\//.test(value) ? "private-registry" : value;
    else if (value !== undefined) out[key] = "custom";
  }
  return out;
}

export function formatReport(info: ReportInfo): string {
  return [
    "### Problem", "", info.problem.trim() || "_Describe what you did, what you expected and what happened._", "",
    "### Environment", "",
    "- Hushavyr: " + info.extension, "- VS Code: " + info.vscode, "- OS: " + info.os, "- Memory: " + info.memoryGb + " GB",
    "- Tools on PATH: " + Object.entries(info.tools).map(([k, v]) => k + (v ? " yes" : " no")).join(", "), "",
    "### Settings (redacted)", "", "```json", JSON.stringify(redactSettings(info.settings), null, 2), "```", "",
    "_Generated locally by Hushavyr: Report an Issue. Contains no code, file names, paths or endpoints._"
  ].join("\n");
}
