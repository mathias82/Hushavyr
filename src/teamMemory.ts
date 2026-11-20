import {createHash} from "node:crypto";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {Finding} from "./review";

/**
 * Team memory lives in the repository (.hushavyr/dismissed.json) so a false positive dismissed by one
 * developer is hidden for everyone after commit. Only fingerprints, paths and short reasons are stored.
 */
export interface Dismissal { fingerprint: string; path: string; reason: string; date: string }

export const DISMISSED_FILE = join(".hushavyr", "dismissed.json");

/** Survives line moves: the workspace-relative file plus the whitespace-normalised flagged line. */
export function fingerprint(relativePath: string, lineText: string): string {
  return createHash("sha256").update(relativePath.replace(/\\/g, "/") + "\0" + lineText.replace(/\s+/g, " ").trim()).digest("hex").slice(0, 16);
}

export async function loadDismissals(root: string): Promise<Dismissal[]> {
  try {
    const data: unknown = JSON.parse(await readFile(join(root, DISMISSED_FILE), "utf8"));
    const list = (data as {dismissed?: unknown})?.dismissed;
    return Array.isArray(list) ? list.filter((d): d is Dismissal => typeof d?.fingerprint === "string") : [];
  } catch { return []; }
}

export async function addDismissal(root: string, entry: Omit<Dismissal, "date">, now = new Date()): Promise<void> {
  const list = await loadDismissals(root);
  if (list.some(d => d.fingerprint === entry.fingerprint)) return;
  list.push({...entry, reason: entry.reason.replace(/[\r\n]+/g, " ").slice(0, 200), date: now.toISOString().slice(0, 10)});
  await mkdir(join(root, ".hushavyr"), {recursive: true});
  await writeFile(join(root, DISMISSED_FILE), JSON.stringify({dismissed: list}, null, 2) + "\n");
}

/** Drops findings the team dismissed; relativePath maps a finding path to its workspace-relative path. */
export function withoutDismissed(findings: readonly Finding[], dismissed: readonly Dismissal[],
  relativePath: (path: string) => string | undefined): {kept: Finding[]; hidden: number} {
  const known = new Set(dismissed.map(d => d.fingerprint));
  const kept = findings.filter(f => {
    const rel = f.path ? relativePath(f.path) : undefined;
    return !rel || !known.has(fingerprint(rel, f.evidence.split("\n")[0]));
  });
  return {kept, hidden: findings.length - kept.length};
}
