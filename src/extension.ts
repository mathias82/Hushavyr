import {registerApplyFix} from "./fix/applyFix";
import {exportWorkspaceSbom, registerDependencyQuickFix, updateTrivyDatabase} from "./deps/trivyCommands";
import * as vscode from "vscode";
import {registerVerifiedFix} from "./fix/fixAgent";
import {registerVerifiedFixPr} from "./fix/fixPrAgent";
import {createAutoPrompt} from "./vscode/autoPrompt";
import {registerEditCommands} from "./fix/editFlow";
import {registerEscalationCommands} from "./escalation/escalateSuggest";
import {registerPullRequestCommand} from "./vscode/prFlow";
import {addDismissal, dismissalText, fingerprint} from "./scan/teamMemory";
import {runSetup} from "./model/setup";
import {clearDependencyMarkers} from "./scan/workspaceScan";
import {registerOllamaCommands} from "./model/ollamaCommands";
import {registerLocalCommands} from "./vscode/localCommands";
import {registerChatParticipant} from "./vscode/chatParticipant";
import {registerReportIssue} from "./vscode/reportIssue";
import {clearScanFindings, dropScanFinding, registerPaletteCommands} from "./vscode/paletteCommands";
import {forgetFinding, registerExplainFinding} from "./vscode/explainFinding";
import {dropDependencyMarker} from "./deps/dependencyMarkers";
import {registerTerminalCommand} from "./terminal/register";
import {UPDATE_VULN_DBS, updateVulnerabilityDatabases} from "./deps/vulnDb";

export function activate(context: vscode.ExtensionContext): void {
  registerVerifiedFix(context);
  registerVerifiedFixPr(context);
  const reviewDiagnostics = vscode.languages.createDiagnosticCollection("hushavyr");
  context.subscriptions.push(reviewDiagnostics,
    vscode.commands.registerCommand("aiPrivacyRouter.clearFindings", () => { reviewDiagnostics.clear(); clearDependencyMarkers(); clearScanFindings(); }),
    // Team memory: the dismissal is written to the repository so it applies to everyone after commit.
    vscode.commands.registerCommand("aiPrivacyRouter.dismissFinding", async (uriText: string, line: number, message = "") => {
      const uri = vscode.Uri.parse(uriText);
      const folder = vscode.workspace.getWorkspaceFolder(uri);
      if (!folder || !vscode.workspace.isTrusted) { void vscode.window.showWarningMessage("Open the file inside a trusted workspace folder to share a dismissal."); return; }
      const document = await vscode.workspace.openTextDocument(uri);
      const reason = await vscode.window.showInputBox({prompt: "Why is this not a real issue? (saved in .hushavyr/dismissed.json, shared with the team)", ignoreFocusOut: true});
      if (reason === undefined) return;
      const path = vscode.workspace.asRelativePath(uri, false);
      await addDismissal(folder.uri.fsPath, {fingerprint: fingerprint(path, dismissalText(document.lineAt(line).text, message)), path, reason: reason || "false positive"});
      reviewDiagnostics.set(uri, (reviewDiagnostics.get(uri) ?? []).filter(d => d.range.start.line !== line));
      dropDependencyMarker(uri, line);
      dropScanFinding(uri, line);
      forgetFinding(uriText, line + 1);
      void vscode.window.showInformationMessage("Hidden from future reviews and scans. Commit .hushavyr/dismissed.json to share it with the team.");
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
  registerEscalationCommands(context);
  registerPullRequestCommand(context);
  registerOllamaCommands(context);
  registerReportIssue(context);
  const autoPrompt = createAutoPrompt(context);
  registerLocalCommands(context, autoPrompt);
  registerPaletteCommands(context, registerChatParticipant(context, reviewDiagnostics, autoPrompt));
  registerExplainFinding(context);
  registerTerminalCommand(context);
}

export function deactivate(): void {}
