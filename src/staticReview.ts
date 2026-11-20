import {execFile} from "node:child_process";
import {mkdtemp, writeFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Finding} from "./review";
import {ReviewInput, reviewSources} from "./context";
import {scanSecurity} from "./securityRules";
import {flowSeverity, flowTitle, taintFlows} from "./taint";

/** Runs semgrep and resolves with stdout; rejects with code "ENOENT" when semgrep is not installed. */
export type SemgrepRunner = (args: string[], cwd: string, signal?: AbortSignal) => Promise<string>;
export interface StaticResult { status: "ok" | "missing" | "failed"; findings: Finding[] }

const EXT = /\.(java|kt|py|js|jsx|mjs|cjs|ts|tsx|go|rb|php|cs|rs)(?:$|[?#])/i;
const SEVERITY: Record<string, string> = {ERROR: "high", WARNING: "medium", INFO: "low"};

const defaultRunner: SemgrepRunner = (args, cwd, signal) => new Promise((resolve, reject) =>
  execFile("semgrep", args, {cwd, timeout: 60000, maxBuffer: 8 * 1024 * 1024, windowsHide: true, signal,
    env: {...process.env, SEMGREP_SEND_METRICS: "off", SEMGREP_ENABLE_VERSION_CHECK: "0"}},
  (error, stdout) => {
    // Semgrep exits 1 when it finds something; its JSON is still complete.
    if (error && (error as NodeJS.ErrnoException).code === "ENOENT") reject(error);
    else if (stdout) resolve(stdout);
    else reject(error ?? new Error("semgrep returned no output"));
  }));

const clean = (value: unknown, max: number): string =>
  typeof value === "string" ? value.replace(/[\r\n]+/g, " ").trim().slice(0, max) : "";

/** Maps semgrep JSON for the temporary copies (f0.java, f1.py, ...) back to the review sources. */
export function semgrepToFindings(stdout: string, source: ReviewInput): Finding[] {
  const files = reviewSources(source);
  let data: unknown;
  try { data = JSON.parse(stdout); } catch { return []; }
  const results = (data as {results?: unknown[]})?.results;
  if (!Array.isArray(results)) return [];
  const findings: Finding[] = [];
  for (const row of results.slice(0, 50)) {
    const r = row as {path?: unknown; start?: {line?: unknown}; extra?: {message?: unknown; severity?: unknown; metadata?: {fix?: unknown; test?: unknown}}};
    const index = /^f(\d+)\./.exec(typeof r.path === "string" ? r.path.split(/[\\/]/).pop()! : "")?.[1];
    const file = index === undefined ? undefined : files[Number(index)];
    const line = r.start?.line;
    if (!file || typeof line !== "number" || line < 1) continue;
    const evidence = file.text.split(/\r?\n/)[line - 1]?.trim() ?? "";
    if (evidence.length < 8) continue;
    findings.push({
      title: "Local rule: " + (clean(r.extra?.message, 160) || "Static analysis finding"),
      severity: SEVERITY[clean(r.extra?.severity, 10).toUpperCase()] ?? "medium",
      evidence, status: "potential", path: file.path, line: (file.startLine ?? 1) + line - 1,
      fix: clean(r.extra?.metadata?.fix, 300) || "Inspect the flagged code and apply the rule-specific remediation.",
      regressionTest: clean(r.extra?.metadata?.test, 300) || "Add a test with a hostile input for this code path."
    });
  }
  return dedupe(findings);
}

/** Bundled regex rules: the fallback when semgrep is unavailable. Only high-severity rules, to keep noise down. */
export function regexFindings(source: ReviewInput): Finding[] {
  const findings: Finding[] = [];
  for (const file of reviewSources(source)) {
    const ext = EXT.exec(file.path)?.[1];
    if (!ext) continue;
    const lines = file.text.split(/\r?\n/);
    for (const issue of scanSecurity("x." + ext.toLowerCase(), file.text)) {
      const evidence = lines[issue.line - 1]?.trim() ?? "";
      if (issue.severity !== "HIGH" || evidence.length < 8) continue;
      findings.push({title: "Local rule: " + issue.rule, severity: "high", evidence, fix: issue.advice,
        regressionTest: "Add a test with a hostile input for this code path.", status: "potential",
        path: file.path, line: (file.startLine ?? 1) + issue.line - 1});
    }
  }
  return dedupe(findings);
}

/** Request input that reaches a dangerous call, followed across the supplied files and functions. */
export function taintFindings(source: ReviewInput): Finding[] {
  const files = reviewSources(source).filter(f => EXT.test(f.path));
  const findings: Finding[] = [];
  for (const flow of taintFlows(files)) {
    const file = files.find(f => f.path === flow.sink.path)!;
    const evidence = file.text.split(/\r?\n/)[flow.sink.line - 1]?.trim() ?? "";
    if (evidence.length < 8) continue;
    findings.push({title: "Local rule: " + flowTitle(flow), severity: flowSeverity(flow), evidence, status: "potential",
      path: file.path, line: (file.startLine ?? 1) + flow.sink.line - 1,
      fix: "Validate or parameterise the input before it reaches this call (bind SQL parameters, avoid shell strings, allow-list paths and hosts, encode HTML).",
      regressionTest: "Call the entry point with a hostile value and assert it is rejected or handled as data."});
  }
  return findings;
}

function dedupe(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  return findings.filter(f => { const key = f.path + ":" + f.line; return !seen.has(key) && !!seen.add(key); });
}

/** Static half of the hybrid review: semgrep with the bundled rule pack on temporary copies of the sources; no network. */
export async function staticReview(source: ReviewInput, rulesPath: string,
  runner: SemgrepRunner = defaultRunner, signal?: AbortSignal): Promise<StaticResult> {
  const files = reviewSources(source);
  const scannable = files.map((file, i) => ({i, ext: EXT.exec(file.path)?.[1]?.toLowerCase(), file})).filter(f => f.ext);
  if (!scannable.length) return {status: "ok", findings: []};
  const dir = await mkdtemp(join(tmpdir(), "hushavyr-review-"));
  try {
    for (const {i, ext, file} of scannable) await writeFile(join(dir, "f" + i + "." + ext), file.text, "utf8");
    const stdout = await runner(["scan", "--config", rulesPath, "--json", "--metrics=off",
      "--disable-version-check", "--no-git-ignore", "--quiet", "."], dir, signal);
    return {status: "ok", findings: dedupe([...semgrepToFindings(stdout, files), ...taintFindings(source)])};
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException)?.code === "ENOENT";
    return {status: missing ? "missing" : "failed", findings: dedupe([...regexFindings(source), ...taintFindings(source)])};
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
}
