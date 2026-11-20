import * as vscode from "vscode";
import type { Finding } from "./review";

export interface DiagnosticEntry { uri: string; line: number; severity: string; message: string }

/** Only findings tied to a real file or untitled document can be shown inline; "selection" paths are skipped. */
export function toDiagnosticEntries(findings: readonly Finding[]): DiagnosticEntry[] {
  const entries: DiagnosticEntry[] = [];
  for (const f of findings) {
    if (!f.path || !f.line || !/^(?:file|untitled):/.test(f.path)) continue;
    const prefix = f.title.startsWith("Local rule:") ? "" : "Potential: ";
    entries.push({uri: f.path, line: f.line, severity: f.severity,
      message: prefix + f.title + "\nFix: " + f.fix + "\nTest: " + f.regressionTest});
  }
  return entries;
}

const levels: Record<string, vscode.DiagnosticSeverity> = {
  high: vscode.DiagnosticSeverity.Error, medium: vscode.DiagnosticSeverity.Warning, low: vscode.DiagnosticSeverity.Information
};

/** Replaces earlier review markers; everything stays local and is cleared by the user or the next review. */
export function publishFindings(collection: vscode.DiagnosticCollection, findings: readonly Finding[]): number {
  collection.clear();
  const byUri = new Map<string, vscode.Diagnostic[]>();
  for (const e of toDiagnosticEntries(findings)) {
    const line = Math.max(0, e.line - 1);
    const diagnostic = new vscode.Diagnostic(new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER),
      e.message, levels[e.severity] ?? vscode.DiagnosticSeverity.Warning);
    diagnostic.source = "Hushavyr";
    byUri.set(e.uri, [...(byUri.get(e.uri) ?? []), diagnostic]);
  }
  for (const [uri, list] of byUri) collection.set(vscode.Uri.parse(uri), list);
  return byUri.size;
}
