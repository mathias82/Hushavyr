#!/usr/bin/env node
import {execFile} from "node:child_process";
import {readFile, stat, writeFile} from "node:fs/promises";
import {join, resolve} from "node:path";
import {LocalOllama} from "./model/ollama";
import {runLocalReview} from "./review/localReview";
import {staticReview} from "./scan/staticReview";
import {Finding, reviewSummary} from "./review/review";
import {loadDismissals, loadTeamRules, withoutDismissed, withTeamRules} from "./scan/teamMemory";
import {totalmem} from "node:os";
import {recommendedModel, verifyModeFor} from "./model/model";
import {sarifLevel, toSarif} from "./scan/sarif";

const SOURCE = /\.(?:java|kt|py|js|jsx|mjs|cjs|ts|tsx|go|rs|cs|rb|php)$/;
export const COMMENT_MARKER = "<!-- hushavyr-pr-review -->";

/** Added/changed line numbers per file from `git diff -U0`. Deleted files and pure deletions are ignored. */
export function changedLines(diff: string): Map<string, Set<number>> {
  const files = new Map<string, Set<number>>();
  let current: Set<number> | undefined;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const path = line.slice(4).trim();
      current = path === "/dev/null" ? undefined : new Set<number>();
      if (current) files.set(path.replace(/^b\//, ""), current);
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk && current) {
      const start = Number(hunk[1]), count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      for (let n = start; n < start + count; n++) current.add(n);
    }
  }
  return files;
}

/** Keeps findings on (or within `slack` lines of) changed lines, so a PR is judged on what it changed. */
export function onChangedLines(findings: readonly Finding[], changed: ReadonlySet<number>, slack = 2): Finding[] {
  return findings.filter(f => {
    if (!f.line) return false;
    const span = Math.max(1, f.evidence.split("\n").length);
    for (let n = f.line - slack; n < f.line + span + slack; n++) if (changed.has(n)) return true;
    return false;
  });
}

function plain(text: string, max: number): string {
  return text.replace(/\s+/g, " ").replace(/[<>`|]/g, "'").trim().slice(0, max);
}

/** Markdown for a PR comment. Model text is flattened and stripped of markup so it cannot inject HTML or tables. */
export function prComment(findings: readonly Finding[], reviewed: number, hidden: number): string {
  const head = [COMMENT_MARKER, "### Hushavyr local review", ""];
  const foot = (hidden ? hidden + " finding(s) hidden by team memory. " : "") + "_Reviewed by a local model. No code left the runner._";
  if (!findings.length) return [...head, "No bugs or security issues found in the changed lines of " + reviewed + " file(s).", "", foot].join("\n");
  const rows = findings.map(f => "| " + f.severity.toUpperCase() + " | " + plain(f.path ?? "", 120) + ":" + (f.line ?? 1) + " | " + plain(f.title, 160) + " | " + plain(f.fix, 240) + " |");
  return [...head, reviewSummary({findings: [...findings], rejected: 0}).replace(/[<>`|]/g, "'"), "", "| Severity | Where | Issue | Fix |", "|---|---|---|---|", ...rows, "",
    foot].join("\n");
}

function git(root: string, args: string[]): Promise<string> {
  return new Promise((done, fail) => execFile("git", args, {cwd: root, maxBuffer: 64 * 1024 * 1024}, (error, stdout) => error ? fail(error) : done(stdout)));
}

async function main(args: string[]): Promise<void> {
  let root = ".", base = "origin/main", markdown = "", sarif = "", failOn = "high", depth: "fast" | "thorough" | "light" = "fast", maxFiles = 20;
  let model = process.env.OLLAMA_MODEL ?? "";
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--base") base = args[++i] ?? base;
    else if (a === "--markdown") markdown = args[++i] ?? "";
    else if (a === "--sarif") sarif = args[++i] ?? "";
    else if (a === "--fail-on") failOn = args[++i] ?? "high";
    else if (a === "--model") model = args[++i] ?? "";
    else if (a === "--thorough") depth = "thorough";
    else if (a === "--light") depth = "light";
    else if (a === "--max-files") maxFiles = Math.max(1, Number(args[++i]) || 20);
    else if (a === "--help") { console.log("Usage: hushavyr-review [folder] [--base origin/main] [--model name] [--thorough|--light] [--max-files 20] [--markdown comment.md] [--sarif review.sarif] [--fail-on high|medium|none]"); return; }
    else root = a;
  }
  if (!/^[\w./-]+$/.test(base) || base.startsWith("-")) throw new Error("Invalid --base");
  root = resolve(root);
  model = model.trim() || recommendedModel(totalmem());
  const client = new LocalOllama({model, endpoint: process.env.OLLAMA_ENDPOINT, timeoutMs: 300000});
  await client.ensureAvailable();
  const changed = changedLines(await git(root, ["diff", "-U0", "--no-color", "--diff-filter=AM", base + "...HEAD"]));
  const files = [...changed.keys()].filter(p => SOURCE.test(p)).slice(0, maxFiles);
  const rules = await loadTeamRules(root);
  const dismissed = await loadDismissals(root);
  const rulePack = join(__dirname, "..", "rules", "hushavyr-review.yml");
  let all: Finding[] = [], hidden = 0;
  for (const path of files) {
    const full = join(root, path);
    if ((await stat(full)).size > 200_000) continue;
    const sources = [{path, text: await readFile(full, "utf8")}];
    console.log("reviewing " + path);
    const result = await runLocalReview(client, withTeamRules("Review this change for bugs and security issues.", rules), sources, () => false, client,
      {depth, verify: verifyModeFor(model), staticFindings: staticReview(sources, rulePack).then(r => r.findings)});
    if (!result || result.error) { console.log("  skipped: " + (result?.error ?? "no result")); continue; }
    const relevant = onChangedLines(result.findings, changed.get(path) ?? new Set());
    const filtered = withoutDismissed(relevant, dismissed, p => p);
    hidden += filtered.hidden;
    all = all.concat(filtered.kept.map(f => ({...f, path})));
  }
  for (const f of all) console.log(f.severity.toUpperCase() + " " + f.path + ":" + f.line + " " + f.title);
  console.log(all.length + " findings in " + files.length + " changed file(s). Nothing left this machine.");
  if (markdown) await writeFile(markdown, prComment(all, files.length, hidden));
  if (sarif) {
    const version = (JSON.parse(await readFile(join(__dirname, "..", "package.json"), "utf8")) as {version: string}).version;
    await writeFile(sarif, JSON.stringify(toSarif(all.map(f => ({ruleId: "hushavyr-review", message: f.title + ". Fix: " + f.fix, path: f.path ?? "", line: f.line ?? 1, level: sarifLevel(f.severity)})), version), null, 2));
  }
  if (failOn !== "none" && all.some(f => f.severity === "high" || (failOn === "medium" && f.severity === "medium"))) process.exitCode = 1;
}
if (require.main === module) main(process.argv.slice(2)).catch((error: Error) => { console.error("Review failed:", error.message); process.exitCode = 2; });
