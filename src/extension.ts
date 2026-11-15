import * as vscode from "vscode";
import { classify } from "./classifier";
import { LocalOllama } from "./ollama";

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.commands.registerCommand("aiPrivacyRouter.classifySelection", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { void vscode.window.showWarningMessage("Open a file and select text first."); return; }
    const selected = editor.document.getText(editor.selection);
    const decision = classify(selected);
    void vscode.window.showInformationMessage(`AI Privacy Router: ${decision.route}; ${decision.reasons.join(", ")}. No content transmitted.`);
  }));
  context.subscriptions.push(vscode.commands.registerCommand("aiPrivacyRouter.askLocal", async () => {
    const prompt = await vscode.window.showInputBox({ prompt: "Ask local Qwen (never sent to cloud)", ignoreFocusOut: true });
    if (!prompt?.trim()) return;
    const model = vscode.workspace.getConfiguration("aiPrivacyRouter").get<string>("ollamaModel", "qwen2.5-coder:7b");
    const decision = classify(prompt);
    if (decision.route !== "local") { void vscode.window.showErrorMessage("Unexpected routing decision"); return; }
    try {
      const result = await vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:"Local Qwen processing"}, () => new LocalOllama({model}).generate(prompt));
      const doc = await vscode.workspace.openTextDocument({content:result,language:"markdown"});
      await vscode.window.showTextDocument(doc,{preview:true});
    } catch {
      void vscode.window.showErrorMessage("Local Ollama unavailable. Install Ollama and pull the configured model. No cloud request was made.");
    }
  }));
}
export function deactivate(): void {}
