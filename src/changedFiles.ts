import {isAbsolute, normalize} from "node:path";
import {exec} from "./exec";
const CODE = /\.(?:java|kt|[cm]?[jt]sx?|py|go|rs|cs|php|rb|c|cc|cpp|h|hpp|swift|sql|ya?ml|json|xml|gradle|sh)$/i;

/** Safe, bounded list of changed code files from `git` output (relative paths only, no traversal). */
export function parseChangedFiles(output: string, limit = 12): string[] {
  const seen = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const path = line.trim();
    if (!path || isAbsolute(path) || normalize(path).split(/[\\/]/).includes("..") || !CODE.test(path)) continue;
    if (/(?:^|\/)(?:node_modules|dist|build|target|\.git)\//.test(path) || /package-lock\.json$|\.lock$/.test(path)) continue;
    seen.add(path);
    if (seen.size >= limit) break;
  }
  return [...seen];
}

/** Uncommitted changes (staged, unstaged and new files) in a local repository; empty when git is unavailable. */
export async function changedFiles(root: string): Promise<string[]> {
  try {
    const opts = {cwd: root, timeout: 15000, windowsHide: true, maxBuffer: 1024 * 1024};
    const [tracked, untracked] = await Promise.all([
      exec("git", ["diff", "--name-only", "--diff-filter=d", "HEAD"], opts),
      exec("git", ["ls-files", "--others", "--exclude-standard"], opts)]);
    return parseChangedFiles(tracked.stdout + "\n" + untracked.stdout);
  } catch { return []; }
}
