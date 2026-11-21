import * as vscode from "vscode";
import {join} from "node:path";
import {bumpVersion, exportSbom, firstFixedVersion, parseMarkerMessage} from "./dependencyAudit";
import {tr} from "./i18n";
import {exec} from "./exec";

export const uiLanguage = (): string => vscode.workspace.getConfiguration("aiPrivacyRouter").get<string>("language", "en");

/** The only Trivy operation that uses the network, and only after explicit consent. */
export async function updateTrivyDatabase(): Promise<void> {
  const language = uiLanguage();
  const choice = await vscode.window.showWarningMessage(tr(language, "dbConfirm"), {modal: true}, tr(language, "dbDownload"));
  if (choice !== tr(language, "dbDownload")) return;
  try {
    await vscode.window.withProgress({location: vscode.ProgressLocation.Notification, title: "Trivy"}, async () => {
      await exec("trivy", ["image", "--download-db-only", "--quiet"], {timeout: 600000, windowsHide: true});
      await exec("trivy", ["image", "--download-java-db-only", "--quiet"], {timeout: 600000, windowsHide: true});
    });
    void vscode.window.showInformationMessage(tr(language, "dbDone"));
  } catch {
    void vscode.window.showErrorMessage(tr(language, "dbFailed"));
  }
}

export async function exportWorkspaceSbom(): Promise<void> {
  const language = uiLanguage();
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const output = join(folder.uri.fsPath, "hushavyr-sbom.cdx.json");
    const result = await exportSbom(folder.uri.fsPath, output);
    if (result.ok) void vscode.window.showInformationMessage(tr(language, "sbomDone") + " hushavyr-sbom.cdx.json");
    else void vscode.window.showErrorMessage("Hushavyr: " + result.note);
  }
}

/** Offers "Update to <fixed version>" on dependency markers whose version is on the marked line. */
export function registerDependencyQuickFix(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.languages.registerCodeActionsProvider({scheme: "file"}, {
    provideCodeActions(document, _range, ctx) {
      const actions: vscode.CodeAction[] = [];
      for (const diagnostic of ctx.diagnostics) {
        if (diagnostic.source !== "Hushavyr") continue;
        const info = parseMarkerMessage(diagnostic.message);
        const fixed = info && firstFixedVersion(info.fixed, info.installed);
        if (!info || !fixed) continue;
        const line = diagnostic.range.start.line;
        const text = document.lineAt(line).text;
        const bumped = bumpVersion(text, info.installed, fixed);
        if (!bumped) continue;
        const action = new vscode.CodeAction(tr(uiLanguage(), "quickFix") + " " + info.pkg + " " + fixed, vscode.CodeActionKind.QuickFix);
        action.diagnostics = [diagnostic];
        action.edit = new vscode.WorkspaceEdit();
        action.edit.replace(document.uri, new vscode.Range(line, 0, line, text.length), bumped);
        action.isPreferred = true;
        actions.push(action);
      }
      return actions;
    }
  }, {providedCodeActionKinds: [vscode.CodeActionKind.QuickFix]}));
}
