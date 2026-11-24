import {enclosingFunction} from "../fix/fixEdit";
import type {ReviewSource} from "./context";

/** 1-based inclusive line range. */
export interface Region { start: number; end: number }

/**
 * The parts of a file a review of a change needs: each changed line widened to its enclosing function (or a few
 * lines around it outside functions), merged. Fewer lines to read makes the local model faster.
 */
export function changedRegions(path: string, text: string, changed: ReadonlySet<number>, pad = 3): Region[] {
  const total = text.split(/\r?\n/).length;
  const raw: Region[] = [];
  for (const line of [...changed].filter(n => n >= 1 && n <= total).sort((a, b) => a - b)) {
    const fn = enclosingFunction(path, text, line, 200);
    raw.push(fn ? {start: fn.start + 1, end: fn.end + 1} : {start: Math.max(1, line - pad), end: Math.min(total, line + pad)});
  }
  raw.sort((a, b) => a.start - b.start);
  const merged: Region[] = [];
  for (const r of raw) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end + 2) last.end = Math.max(last.end, r.end);
    else merged.push({...r});
  }
  return merged;
}

/**
 * Review sources for the changed parts of one file. The whole file when the change touches most of it (or when
 * `changed` is "all", e.g. a new file), otherwise one excerpt per region with its real start line.
 */
export function changedSources(path: string, text: string, changed: ReadonlySet<number> | "all", wholeShare = 0.7): ReviewSource[] {
  if (changed === "all") return [{path, text, startLine: 1}];
  const lines = text.split(/\r?\n/);
  const regions = changedRegions(path, text, changed);
  if (!regions.length) return [];
  const covered = regions.reduce((n, r) => n + r.end - r.start + 1, 0);
  if (covered >= lines.length * wholeShare) return [{path, text, startLine: 1}];
  return regions.map(r => ({path, text: lines.slice(r.start - 1, r.end).join("\n"), startLine: r.start}));
}
