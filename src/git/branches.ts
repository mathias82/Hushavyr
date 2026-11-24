import {execFile} from "node:child_process";

export type Exec = (cmd: string, args: string[], cwd: string) => Promise<string>;
const defaultExec: Exec = (cmd, args, cwd) => new Promise((resolve, reject) =>
  execFile(cmd, args, {cwd, maxBuffer: 4 * 1024 * 1024, timeout: 60_000}, (error, stdout, stderr) =>
    error ? reject(new Error((stderr || error.message).trim())) : resolve(stdout)));

async function currentBranch(root: string, exec: Exec): Promise<string> {
  try { return (await exec("git", ["symbolic-ref", "--short", "HEAD"], root)).trim(); } catch { return "HEAD"; }
}

export interface BranchCommits {branch: string; base?: string; commits: string[]}
/** Commits of the current branch: only those not on the base branch (origin's default, else main/master), or the latest `limit` on the base itself. */
export async function branchCommits(root: string, exec: Exec = defaultExec, limit = 50): Promise<BranchCommits | string> {
  try { await exec("git", ["rev-parse", "--is-inside-work-tree"], root); } catch { return "This folder is not a git repository."; }
  const branch = await currentBranch(root, exec);
  try { await exec("git", ["rev-parse", "--verify", "--quiet", "HEAD"], root); } catch { return "No commits yet on " + branch + "."; }
  let base: string | undefined;
  try { base = (await exec("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], root)).trim(); } catch { /* no remote default */ }
  for (const name of base ? [] : ["origin/main", "origin/master", "main", "master"]) {
    try { await exec("git", ["rev-parse", "--verify", "--quiet", name], root); base = name; break; } catch { /* try next */ }
  }
  const onBase = !base || base.replace(/^origin\//, "") === branch;
  const range = onBase ? ["HEAD"] : [base + "..HEAD"];
  const log = await exec("git", ["log", "--no-color", "-n", String(limit), "--format=%h  %ad  %an  %s", "--date=format:%Y-%m-%d %H:%M", ...range, "--"], root);
  return {branch, base: onBase ? undefined : base, commits: log.split("\n").filter(Boolean)};
}

/** A readable report of `branchCommits`. */
export function formatBranchCommits(c: BranchCommits): string {
  const head = c.base ? "Commits on " + c.branch + " not on " + c.base + " (" + c.commits.length + "):" : "Latest commits on " + c.branch + " (" + c.commits.length + "):";
  return head + "\n" + (c.commits.length ? c.commits.join("\n") : "(none: the branch has nothing new)");
}

export interface Branches {current: string; local: string[]; remote: string[]}
export async function listBranches(root: string, exec: Exec = defaultExec): Promise<Branches | string> {
  try { await exec("git", ["rev-parse", "--is-inside-work-tree"], root); } catch { return "This folder is not a git repository."; }
  const refs = (await exec("git", ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"], root)).split("\n").filter(Boolean);
  const local = refs.filter(r => r.startsWith("refs/heads/")).map(r => r.slice(11));
  const remote = refs.filter(r => r.startsWith("refs/remotes/") && !r.endsWith("/HEAD")).map(r => r.slice(13)).filter(r => !local.includes(r.replace(/^[^/]+\//, "")));
  return {current: await currentBranch(root, exec), local, remote};
}

export function formatBranches(b: Branches): string {
  const lines = b.local.map(n => (n === b.current ? "* " : "  ") + n);
  if (!b.local.includes(b.current)) lines.unshift("* " + b.current + " (no commits yet)");
  return "Branches:\n" + lines.join("\n") + (b.remote.length ? "\nOnly on the remote:\n" + b.remote.map(n => "  " + n).join("\n") : "");
}

/** A safe branch name: letters, digits, `.`, `_`, `-`, `/`; no `..`, no leading `-` or `/`. */
export function validBranchName(name: string): boolean {
  return /^[\w][\w./-]*$/.test(name) && !name.includes("..") && !name.endsWith("/") && !name.endsWith(".lock") && name.length <= 100;
}

/** Whether `name` exists locally (`local`), only on origin (`remote`), or not at all. */
export async function branchExists(root: string, name: string, exec: Exec = defaultExec): Promise<"local" | "remote" | undefined> {
  try { await exec("git", ["rev-parse", "--verify", "--quiet", "refs/heads/" + name], root); return "local"; } catch { /* not local */ }
  try { await exec("git", ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/" + name], root); return "remote"; } catch { return undefined; }
}

/** Switches branch, carrying uncommitted changes; `create` makes a new branch from the current one. A remote-only branch is tracked. */
export async function switchBranch(root: string, name: string, create: boolean, exec: Exec = defaultExec): Promise<string> {
  if (!validBranchName(name)) throw new Error("Invalid branch name: " + name);
  await exec("git", create ? ["switch", "-c", name] : ["switch", name], root);
  return currentBranch(root, exec);
}

export interface PushPlan {branch: string; commits: string[]; dirty: number; upstream: boolean}
/** What /push would send: commits on the current branch that are on no remote branch yet; `dirty` counts uncommitted files (not pushed). */
export async function planPush(root: string, exec: Exec = defaultExec): Promise<PushPlan | string> {
  try { await exec("git", ["rev-parse", "--is-inside-work-tree"], root); } catch { return "This folder is not a git repository."; }
  try { await exec("git", ["remote", "get-url", "origin"], root); } catch { return "No `origin` remote is configured."; }
  const branch = await currentBranch(root, exec);
  if (branch === "HEAD" || !validBranchName(branch)) return "Not on a branch (detached HEAD). Use /branch <name> first.";
  try { await exec("git", ["rev-parse", "--verify", "--quiet", "HEAD"], root); } catch { return "No commits yet on " + branch + ". Commit first with /commit."; }
  let upstream = true;
  try { await exec("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], root); } catch { upstream = false; }
  const commits = (await exec("git", ["log", "--no-color", "--format=%h  %s", "HEAD", "--not", "--remotes=origin", "--"], root)).split("\n").filter(Boolean);
  const dirty = (await exec("git", ["status", "--porcelain"], root)).split("\n").filter(Boolean).length;
  return {branch, commits, dirty, upstream};
}

/** Pushes the current branch and sets its upstream. */
export async function pushCurrent(root: string, branch: string, exec: Exec = defaultExec): Promise<void> {
  if (!validBranchName(branch)) throw new Error("Invalid branch name: " + branch);
  await exec("git", ["push", "-u", "origin", branch], root);
}
