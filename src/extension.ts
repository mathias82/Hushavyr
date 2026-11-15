import * as vscode from "vscode";
import { classify } from "./classifier";

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.commands.registerCommand("aiPrivacyRouter.classifySelection", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { void vscode.window.showWarningMessage("Open a file and select text first."); return; }
    const text = editor.document.getText(editor.selection);
    const decision = classify(text);
    void vscode.window.showInformationMessage(`AI Privacy Router: ${decision.route}; ${decision.reasons.join(", ")}. No content was transmitted.`);
  }));
}
export function deactivate(): void {}
