import {isAbsolute, normalize} from "node:path";
import {exec} from "../util/exec";
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

/**
 * Uncommitted changed lines per code file under `root` (paths relative to `root`, never outside it). New files are
 * "all". Same file filter and limit as changedFiles; empty when git is unavailable.
 */
export async function changedLineMap(root: string, limit = 12): Promise<Map<string, Set<number> | "all">> {
  const result = new Map<string, Set<number> | "all">();
  try {
    const opts = {cwd: root, timeout: 15000, windowsHide: true, maxBuffer: 16 * 1024 * 1024};
    const [diff, untracked] = await Promise.all([
      exec("git", ["diff", "-U0", "--no-color", "--no-ext-diff", "--relative", "--diff-filter=AM", "HEAD"], opts).then(r => r.stdout, () => ""),
      exec("git", ["ls-files", "--others", "--exclude-standard"], opts).then(r => r.stdout)]);
    const lines = changedLines(diff);
    const files = parseChangedFiles([...lines.keys()].join("\n") + "\n" + untracked, limit);
    for (const path of files) result.set(path, lines.get(path) ?? "all");
  } catch { /* not a git repository */ }
  return result;
}
