#!/usr/bin/env node
import {execFile} from "node:child_process";
import {readdir, readFile, stat, writeFile} from "node:fs/promises";
import {join, relative, resolve} from "node:path";
import {scanSecurity} from "./securityRules";
import {scanSecrets} from "./secretsScan";
import {auditDependencies, findDependencyLine, groupVulnerabilities} from "./dependencyAudit";
import {SarifResult, sarifLevel, toSarif} from "./sarif";
import {collectImports, findVulnerableCall, vulnerableSymbols} from "./reachability";
import {flowSeverity, flowTitle, taintFlows, TaintFile} from "./taint";

const SKIP = new Set([".git", "node_modules", "target", "build", "dist", "out", "coverage", ".venv", "venv", ".next", ".idea", ".vscode", "vendor", "__pycache__"]);
const SOURCE = /\.(?:java|kt|py|js|jsx|mjs|cjs|ts|tsx|go|rs|cs|rb|php)$/;
const LOCKFILE = /(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|composer\.lock|Cargo\.lock|poetry\.lock|go\.sum)$/;
const CONFIG = /(?:\.(?:env|properties|ya?ml|json|xml|toml|ini|conf)|^\.env(?:\..*)?)$/;

async function walk(dir: string, found: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, {withFileTypes: true})) {
    if (found.length >= 5000) break;
    if (entry.isDirectory()) { if (!SKIP.has(entry.name)) await walk(join(dir, entry.name), found); }
    else if (entry.isFile() && (SOURCE.test(entry.name) || CONFIG.test(entry.name))) found.push(join(dir, entry.name));
  }
  return found;
}

/** Semgrep with the bundled rule pack; returns [] when semgrep is not installed. */
function semgrep(root: string, rules: string): Promise<SarifResult[]> {
  return new Promise(done => execFile("semgrep", ["scan", "--config", rules, "--json", "--metrics=off", "--disable-version-check", "--quiet", "."],
    {cwd: root, timeout: 600000, maxBuffer: 64 * 1024 * 1024, env: {...process.env, SEMGREP_SEND_METRICS: "off"}}, (_error, stdout) => {
      try {
        const data = JSON.parse(stdout) as {results?: {path: string; start: {line: number}; check_id: string; extra?: {message?: string; severity?: string}}[]};
        done((data.results ?? []).map(r => ({ruleId: r.check_id.split(".").slice(-1)[0], message: r.extra?.message ?? r.check_id,
          path: r.path, line: r.start.line, level: sarifLevel(r.extra?.severity ?? "WARNING")})));
      } catch { done([]); }
    }));
}

/** Offline scan of a folder: bundled rules, semgrep (if installed), credentials, Trivy dependencies (if installed). */
export async function scanFolder(root: string, rules: string, log: (line: string) => void = () => undefined): Promise<SarifResult[]> {
  const results: SarifResult[] = [];
  const taintFiles: TaintFile[] = [];
  const depFiles: {path: string; text: string}[] = [];
  for (const file of await walk(root)) {
    if ((await stat(file)).size > 200_000) continue;
    const text = await readFile(file, "utf8");
    if (text.includes("\0")) continue;
    const path = relative(root, file);
    if (SOURCE.test(file)) taintFiles.push({path, text});
    if (SOURCE.test(file) && collectImports(path, text).length) depFiles.push({path, text});
    if (SOURCE.test(file)) for (const issue of scanSecurity(path, text))
      results.push({ruleId: issue.rule.replace(/\W+/g, "-").toLowerCase(), message: issue.rule + ": " + issue.advice, path, line: issue.line, level: sarifLevel(issue.severity)});
    // Lockfiles hold package names and integrity hashes, never credentials.
    if (!LOCKFILE.test(file)) for (const secret of scanSecrets(text))
      results.push({ruleId: "hardcoded-credential", message: "Potential hardcoded credential (" + secret.rule + "); value redacted", path, line: secret.line, level: "error"});
  }
  for (const flow of taintFlows(taintFiles))
    results.push({ruleId: "taint-" + flow.kind, message: flowTitle(flow) + " (input at " + flow.source.path + ":" + flow.source.line + ")", path: flow.sink.path, line: flow.sink.line, level: sarifLevel(flowSeverity(flow))});
  const fromSemgrep = await semgrep(root, rules);
  log("semgrep: " + fromSemgrep.length + " findings");
  for (const r of fromSemgrep) {
    const same = results.findIndex(x => x.path === r.path && x.line === r.line && x.ruleId !== "hardcoded-credential");
    if (same >= 0) results[same] = r; else results.push(r);
  }
  const audit = await auditDependencies(root);
  log("trivy: " + audit.status + " (" + audit.findings + " vulnerabilities)");
  for (const v of groupVulnerabilities(audit.vulnerabilities ?? [])) for (const target of v.targets.slice(0, 3)) {
    let line = 1;
    try { line = findDependencyLine(await readFile(join(root, target), "utf8"), v.pkg, v.installed); } catch { /* target is not a readable file */ }
    const call = findVulnerableCall(v.pkg, target + " " + (audit.manager ?? ""), vulnerableSymbols(v.pkg, v.title ?? ""), depFiles);
    results.push({ruleId: v.id, message: v.id + " in " + v.pkg + " " + v.installed + (v.fixed ? ", fixed in " + v.fixed : ", no fix available") + (v.title ? ": " + v.title : "") +
      (call ? " [vulnerable function " + call.symbol + " called at " + call.path + ":" + call.line + "]" : ""),
      path: target, line, level: sarifLevel(v.severity)});
  }
  return results;
}

async function main(args: string[]): Promise<void> {
  let root = ".", out = "", failOn = "high";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--sarif") out = args[++i] ?? "";
    else if (args[i] === "--fail-on") failOn = args[++i] ?? "high";
    else if (args[i] === "--help") { console.log("Usage: hushavyr-scan [folder] [--sarif report.sarif] [--fail-on high|medium|none]"); return; }
    else root = args[i];
  }
  root = resolve(root);
  const version = (JSON.parse(await readFile(join(__dirname, "..", "package.json"), "utf8")) as {version: string}).version;
  const results = await scanFolder(root, join(__dirname, "..", "rules", "hushavyr-review.yml"), line => console.log(line));
  for (const r of results) console.log(r.level.toUpperCase() + " " + r.path + ":" + r.line + " " + r.ruleId + " - " + r.message);
  console.log(results.length + " findings (" + results.filter(r => r.level === "error").length + " errors). Nothing left this machine.");
  if (out) await writeFile(out, JSON.stringify(toSarif(results, version), null, 2));
  const failing = failOn === "none" ? [] : results.filter(r => r.level === "error" || (failOn === "medium" && r.level === "warning"));
  if (failing.length) process.exitCode = 1;
}
if (require.main === module) main(process.argv.slice(2)).catch((error: Error) => { console.error("Scan failed:", error.message); process.exitCode = 2; });
