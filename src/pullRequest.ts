import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {readFile} from "node:fs/promises";
import {join} from "node:path";
import {scanSecrets} from "./secretsScan";
const run = promisify(execFile);
export type Exec = (cmd: string, args: string[], cwd: string) => Promise<string>;
export const defaultExec: Exec = async (cmd, args, cwd) =>
  (await run(cmd, args, {cwd, timeout: 120_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024})).stdout;

const DEFAULT_BRANCHES = new Set(["main", "master", "develop", "dev", "trunk"]);
export function branchName(title: string, now = new Date()): string {
  const slug = title.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "changes";
  return "hushavyr/" + slug + "-" + now.toISOString().slice(0, 16).replace(/\D/g, "");
}
/** github.com compare URL from an https or ssh remote; undefined for other hosts. */
export function compareUrl(remote: string, base: string, branch: string): string | undefined {
  const m = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(remote.trim());
  return m ? "https://github.com/" + m[1] + "/" + m[2] + "/compare/" + encodeURIComponent(base) + "..." + encodeURIComponent(branch) + "?expand=1" : undefined;
}
/** Changed paths from `git status --porcelain` (renames give the new path). */
export function statusPaths(porcelain: string): string[] {
  return porcelain.split("\n").filter(l => l.length > 3).map(l => l.slice(3).replace(/^.* -> /, "").replace(/^"(.*)"$/, "$1"));
}

export interface PrPlan {root: string; current: string; base: string; files: string[]; stat: string; remote: string}
export async function planPullRequest(root: string, exec: Exec = defaultExec): Promise<PrPlan | string> {
  try { await exec("git", ["rev-parse", "--is-inside-work-tree"], root); } catch { return "This folder is not a git repository."; }
  const files = statusPaths(await exec("git", ["status", "--porcelain", "--untracked-files=all"], root));
  if (!files.length) return "There are no changes to put in a pull request.";
  const current = (await exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], root)).trim();
  let remote = "";
  try { remote = (await exec("git", ["remote", "get-url", "origin"], root)).trim(); } catch { return "No `origin` remote is configured."; }
  let base = current;
  try { base = (await exec("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], root)).trim().replace(/^origin\//, ""); } catch { /* keep current */ }
  let stat = "";
  try { stat = (await exec("git", ["diff", "--stat", "HEAD"], root)).trim(); } catch { /* new repository */ }
  return {root, current, base, files, stat, remote};
}

/** Changed files that look like they contain credentials; such a PR is never pushed. */
export async function secretsInChanges(plan: PrPlan): Promise<string[]> {
  const hits: string[] = [];
  for (const file of plan.files.slice(0, 200)) {
    try { if (scanSecrets(await readFile(join(plan.root, file), "utf8")).length) hits.push(file); } catch { /* deleted or unreadable */ }
  }
  return hits;
}

export interface PrResult {branch: string; url?: string; created: boolean}
export async function createPullRequest(plan: PrPlan, title: string, exec: Exec = defaultExec): Promise<PrResult> {
  const branch = DEFAULT_BRANCHES.has(plan.current) || plan.current === "HEAD" ? branchName(title) : plan.current;
  if (!/^[\w./-]+$/.test(branch)) throw new Error("Invalid branch name");
  if (branch !== plan.current) await exec("git", ["switch", "-c", branch], plan.root);
  await exec("git", ["add", "-A"], plan.root);
  await exec("git", ["commit", "-m", title], plan.root);
  await exec("git", ["push", "-u", "origin", branch], plan.root);
  const base = plan.base === branch ? "main" : plan.base;
  try {
    const out = await exec("gh", ["pr", "create", "--base", base, "--head", branch, "--title", title, "--body",
      "Created with Hushavyr. Changes were prepared locally; review before merging."], plan.root);
    const url = /https:\/\/\S+/.exec(out)?.[0];
    return {branch, url, created: true};
  } catch {
    return {branch, url: compareUrl(plan.remote, base, branch), created: false};
  }
}
