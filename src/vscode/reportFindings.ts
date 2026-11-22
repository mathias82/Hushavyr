// Turns a scan report (the same markdown the Chat answer shows) into Problems panel entries.
// Every scan finding carries a link "[label](<uri>#L<line>)" built by findingLink, so one parser covers all scanners.

import * as path from "path";
import {fileURLToPath} from "url";

export interface ReportFinding { uri: string; line: number; severity: "high" | "medium" | "low"; message: string }

const LINK = /\[([^\]]*)\]\(((?:file|untitled|vscode-[a-z-]+):[^)\s]*?)#L(\d+)\)/;
const SEVERITY: Record<string, ReportFinding["severity"]> = {critical: "high", high: "high", error: "high", medium: "medium", warning: "medium", low: "low", info: "low", note: "low"};

const plain = (text: string) => text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`]/g, "").replace(/^\s*[-#>]+\s*/, "").replace(/\s+/g, " ").trim();

/** One entry per finding line; the first link is the location (for data flows that is the sink). */
export function findingsFromReport(markdown: string): ReportFinding[] {
  const found: ReportFinding[] = [];
  const seen = new Set<string>();
  for (const line of markdown.split(/\r?\n/)) {
    const link = LINK.exec(line);
    if (!link) continue;
    const word = /\b(critical|high|medium|low|error|warning|info|note)\b/i.exec(line.slice(0, link.index))?.[1]?.toLowerCase();
    const entry: ReportFinding = {uri: link[2], line: Number(link[3]), severity: (word && SEVERITY[word]) || "medium", message: plain(line)};
    const key = entry.uri + "#" + entry.line + "#" + entry.message;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(entry);
  }
  return found;
}

/** The Markdown preview refuses file: links, so the saved report points to files relative to the report folder instead. */
export function previewLinks(markdown: string, reportFolder: string): string {
  return markdown.replace(/\]\((file:\/\/[^)\s]*?)(#L\d+)?\)/g, (whole, target: string, line = "") => {
    let relative: string;
    try { relative = path.relative(reportFolder, fileURLToPath(target)); } catch { return whole; }
    if (path.isAbsolute(relative)) return whole;
    return "](<" + relative.split(path.sep).join("/") + line + ">)";
  });
}

/** Prompt for explaining one scanner finding; only the finding and the nearby code are included. */
export function explainFindingPrompt(finding: {message: string; path: string; line: number}, lines: readonly string[], languageId: string): string {
  const start = Math.max(0, finding.line - 26), end = Math.min(lines.length, finding.line + 25);
  const numbered = lines.slice(start, end).map((text, i) => String(start + i + 1).padStart(5) + (start + i + 1 === finding.line ? " >| " : "  | ") + text).join("\n");
  return "A deterministic security scanner reported this finding. Do not invent other issues.\n" +
    "Finding: " + finding.message + "\nLocation: " + finding.path + ":" + finding.line + " (marked with >)\n\n" +
    "Code (" + languageId + "):\n```\n" + numbered.slice(0, 12000) + "\n```\n\n" +
    "Answer in Markdown with these sections:\n" +
    "### What it means here\nExplain the risk in the context of this exact code, in 2-4 sentences.\n" +
    "### Is it real?\nSay whether the code shown confirms it, or what would make it a false positive.\n" +
    "### Suggested fix\nA minimal corrected code snippet for the marked lines, in a fenced code block.\n";
}
