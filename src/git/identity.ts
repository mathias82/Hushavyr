import {execFile} from "node:child_process";

/** Runs a command; `env` adds variables (used for a per-account GH_TOKEN). */
export type Run = (cmd: string, args: string[], cwd: string, env?: Record<string, string>) => Promise<string>;
const defaultRun: Run = (cmd, args, cwd, env) => new Promise((resolve, reject) =>
  execFile(cmd, args, {cwd, timeout: 10_000, env: env ? {...process.env, ...env} : process.env}, (error, stdout, stderr) =>
    error ? reject(new Error((stderr || error.message).trim())) : resolve(stdout)));

export interface AuthorMismatch {current: string; expected: string; login: string}

/** host, owner/repo and the user name in the URL (https://user@host/...) of a GitHub remote. */
export function parseRemote(url: string): {host: string; repo: string; user?: string} | undefined {
  const m = /^(?:https?:\/\/(?:([^@/:]+)(?::[^@/]*)?@)?([^/]+)\/|(?:ssh:\/\/)?git@([^:/]+)[:/])([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? {host: m[2] ?? m[3], repo: m[4], user: m[1]} : undefined;
}

/**
 * Whether new commits would carry an email that the GitHub account pushing to `origin` does not show,
 * so GitHub would not credit the commits (grey avatar, no contributor). Needs `gh`; undefined whenever unsure:
 * no gh, offline, no push access, account without a public email, or the user already kept this email here.
 */
export async function authorMismatch(root: string, run: Run = defaultRun): Promise<AuthorMismatch | undefined> {
  try {
    const current = (await run("git", ["config", "user.email"], root)).trim();
    if (!current) return;
    const kept = (await run("git", ["config", "--local", "hushavyr.keepEmail"], root).catch(() => "")).trim();
    if (kept.toLowerCase() === current.toLowerCase()) return;
    const remote = parseRemote(await run("git", ["remote", "get-url", "origin"], root));
    if (!remote) return;
    const env = remote.user ? {GH_TOKEN: (await run("gh", ["auth", "token", "-h", remote.host, "-u", remote.user], root)).trim()} : undefined;
    if ((await run("gh", ["api", "--hostname", remote.host, "repos/" + remote.repo, "--jq", ".permissions.push"], root, env)).trim() !== "true") return;
    const [login, email, id] = (await run("gh", ["api", "--hostname", remote.host, "user", "--jq", "[.login, (.email // \"\"), (.id | tostring)] | @tsv"], root, env)).trim().split("\t");
    if (!login || !email) return;
    const known = [email, login + "@users.noreply.github.com", id + "+" + login + "@users.noreply.github.com"].map(e => e.toLowerCase());
    if (known.includes(current.toLowerCase())) return;
    return {current, expected: email, login};
  } catch {
    return;
  }
}

/** Sets the email for this repository only (git config --local). */
export async function useEmail(root: string, email: string, run: Run = defaultRun): Promise<void> {
  await run("git", ["config", "--local", "user.email", email], root);
}

/** Remembers that the user keeps `email` in this repository, so Hushavyr does not ask again. */
export async function keepEmail(root: string, email: string, run: Run = defaultRun): Promise<void> {
  await run("git", ["config", "--local", "hushavyr.keepEmail", email], root);
}

export function mismatchText(m: AuthorMismatch): string {
  return "Commits here use " + m.current + ", but your GitHub account " + m.login + " uses " + m.expected + ": GitHub will not show you as the author or a contributor.";
}
