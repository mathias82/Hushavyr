import {createHash} from "node:crypto";

export interface FileFingerprint { path: string; sha256: string }
export interface IndexDiff { changed: FileFingerprint[]; unchanged: number; removed: string[] }
export function fingerprint(path: string, content: Uint8Array): FileFingerprint {
  return {path, sha256: createHash("sha256").update(content).digest("hex")};
}
export function diffIndex(current: FileFingerprint[], previous: FileFingerprint[]): IndexDiff {
  const old = new Map(previous.map(item => [item.path, item.sha256]));
  const seen = new Set<string>();
  const changed: FileFingerprint[] = [];
  let unchanged = 0;
  for (const item of current) {
    if (seen.has(item.path)) throw new Error("Duplicate indexed file path");
    seen.add(item.path);
    if (old.get(item.path) === item.sha256) unchanged++;
    else changed.push(item);
  }
  return {changed, unchanged, removed: previous.filter(item => !seen.has(item.path)).map(item => item.path)};
}
export function parseIndex(value: unknown): FileFingerprint[] {
  if (!Array.isArray(value) || value.length > 5000) return [];
  const valid = value.every(x => x && typeof x === "object" &&
    typeof x.path === "string" && x.path.length < 2048 &&
    typeof x.sha256 === "string" && /^[a-f0-9]{64}$/.test(x.sha256));
  return valid ? value as FileFingerprint[] : [];
}
