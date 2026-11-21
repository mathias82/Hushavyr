import {registerApplyFix} from "./applyFix";
import {exportWorkspaceSbom, registerDependencyQuickFix, updateTrivyDatabase} from "./trivyCommands";
import * as vscode from "vscode";
import {registerVerifiedFix} from "./fixAgent";
import {registerVerifiedFixPr} from "./fixPrAgent";
import {createAutoPrompt} from "./autoPrompt";
import {registerEditCommands} from "./editFlow";
import {registerPullRequestCommand} from "./prFlow";
import {addDismissal, fingerprint} from "./teamMemory";
import {runSetup} from "./setup";
import {clearDependencyMarkers} from "./workspaceScan";
import {registerOllamaCommands} from "./ollamaCommands";
import {registerLocalCommands} from "./localCommands";
import {registerChatParticipant} from "./chatParticipant";
import {registerReportIssue} from "./reportIssue";
import {clearScanFindings, registerPaletteCommands} from "./paletteCommands";
import {registerExplainFinding} from "./explainFinding";
import {UPDATE_VULN_DBS, updateVulnerabilityDatabases} from "./vulnDb";

export function activate(context: vscode.ExtensionContext): void {
  registerVerifiedFix(context);
  registerVerifiedFixPr(context);
  const reviewDiagnostics = vscode.languages.createDiagnosticCollection("hushavyr");
  context.subscriptions.push(reviewDiagnostics,
    vscode.commands.registerCommand("aiPrivacyRouter.clearFindings", () => { reviewDiagnostics.clear(); clearDependencyMarkers(); clearScanFindings(); }),
    // Team memory: the dismissal is written to the repository so it applies to everyone after commit.
    vscode.commands.registerCommand("aiPrivacyRouter.dismissFinding", async (uriText: string, line: number) => {
      const uri = vscode.Uri.parse(uriText);
      const folder = vscode.workspace.getWorkspaceFolder(uri);
      if (!folder || !vscode.workspace.isTrusted) { void vscode.window.showWarningMessage("Open the file inside a trusted workspace folder to share a dismissal."); return; }
      const document = await vscode.workspace.openTextDocument(uri);
      const reason = await vscode.window.showInputBox({prompt: "Why is this not a real issue? (saved in .hushavyr/dismissed.json, shared with the team)", ignoreFocusOut: true});
      if (reason === undefined) return;
      const path = vscode.workspace.asRelativePath(uri, false);
      await addDismissal(folder.uri.fsPath, {fingerprint: fingerprint(path, document.lineAt(line).text), path, reason: reason || "false positive"});
      reviewDiagnostics.set(uri, (reviewDiagnostics.get(uri) ?? []).filter(d => d.range.start.line !== line));
      void vscode.window.showInformationMessage("Hidden from future reviews. Commit .hushavyr/dismissed.json to share it with the team.");
    }));
  // One-time, non-blocking invitation; the user can dismiss it permanently.
  if (!context.globalState.get<boolean>("hushavyr.setupOffered")) {
    void context.globalState.update("hushavyr.setupOffered", true);
    void vscode.window.showInformationMessage("Hushavyr: run first-time setup (local model and optional scanners)?", "Run Setup", "Later")
      .then(choice => { if (choice === "Run Setup") return vscode.commands.executeCommand("aiPrivacyRouter.setup"); });
  }
  context.subscriptions.push(vscode.commands.registerCommand("aiPrivacyRouter.setup", () => runSetup()));
  context.subscriptions.push(vscode.commands.registerCommand("aiPrivacyRouter.updateTrivyDb", () => updateTrivyDatabase()));
  context.subscriptions.push(vscode.commands.registerCommand(UPDATE_VULN_DBS, () => updateVulnerabilityDatabases()));
  context.subscriptions.push(vscode.commands.registerCommand("aiPrivacyRouter.exportSbom", () => exportWorkspaceSbom()));
  registerDependencyQuickFix(context);
  registerApplyFix(context);
  registerEditCommands(context);
  registerPullRequestCommand(context);
  registerOllamaCommands(context);
  registerReportIssue(context);
  const autoPrompt = createAutoPrompt(context);
  registerLocalCommands(context, autoPrompt);
  registerPaletteCommands(context, registerChatParticipant(context, reviewDiagnostics, autoPrompt));
  registerExplainFinding(context);
}

export function deactivate(): void {}
