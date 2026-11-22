import {findDependencyLine, GroupedVulnerability} from "./dependencyAudit";
import {dismissalText, fingerprint, loadDismissals} from "./teamMemory";
import * as vscode from "vscode";

let dependencyMarkers: vscode.DiagnosticCollection | undefined;
export function clearDependencyMarkers(): void { dependencyMarkers?.clear(); }
/** Removes a dismissed marker right away. */
export function dropDependencyMarker(uri: vscode.Uri, line: number): void {
  const list = dependencyMarkers?.get(uri);
  if (list) dependencyMarkers!.set(uri, list.filter(d => d.range.start.line !== line));
}

/** Puts each CVE on its declaration line in the manifest (pom.xml, package.json, ...); markers are local only. */
export async function markDependencies(context: vscode.ExtensionContext, root: vscode.Uri, groups: readonly GroupedVulnerability[]): Promise<void> {
  if (!dependencyMarkers) { dependencyMarkers = vscode.languages.createDiagnosticCollection("hushavyr-dependencies"); context.subscriptions.push(dependencyMarkers); }
  dependencyMarkers.clear();
  const byFile = new Map<string, vscode.Diagnostic[]>();
  const texts = new Map<string, string | undefined>();
  const levels: Record<string, vscode.DiagnosticSeverity> = {
    CRITICAL: vscode.DiagnosticSeverity.Error, HIGH: vscode.DiagnosticSeverity.Error, MEDIUM: vscode.DiagnosticSeverity.Warning
  };
  const dismissed = new Set((await loadDismissals(root.fsPath)).map(d => d.fingerprint));
  for (const v of groups) for (const target of v.targets) {
    if (!target || target.startsWith("/") || target.split(/[\\/]/).includes("..")) continue;
    const uri = vscode.Uri.joinPath(root, target);
    if (dismissed.has(fingerprint(vscode.workspace.asRelativePath(uri, false), dismissalText("", v.id + " in " + v.pkg + " " + v.installed)))) continue;
    if (!texts.has(uri.toString())) {
      try { texts.set(uri.toString(), Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8")); } catch { texts.set(uri.toString(), undefined); }
    }
    const text = texts.get(uri.toString());
    if (text === undefined) continue;
    const line = findDependencyLine(text, v.pkg, v.installed) - 1;
    const diagnostic = new vscode.Diagnostic(new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER),
      v.id + " in " + v.pkg + " " + v.installed + " (" + v.severity + ")" + (v.fixed ? ". Fixed in " + v.fixed + "." : ". No fix available."),
      levels[v.severity] ?? vscode.DiagnosticSeverity.Information);
    diagnostic.source = "Hushavyr";
    byFile.set(uri.toString(), [...(byFile.get(uri.toString()) ?? []), diagnostic]);
  }
  for (const [uri, list] of byFile) dependencyMarkers.set(vscode.Uri.parse(uri), list);
}
