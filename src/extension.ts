import * as vscode from "vscode";
import { classifyInput } from "./classifier";
import { LocalOllama } from "./ollama";

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.commands.registerCommand("aiPrivacyRouter.classifySelection", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      void vscode.window.showWarningMessage("Select text in an editor first.");
      return;
    }
    const selected = editor.document.getText(editor.selection);
    const decision = classifyInput({prompt: selected, workspaceTrusted: vscode.workspace.isTrusted});
    void vscode.window.showInformationMessage(`AI Privacy Router: ${decision.route}; ${decision.reasons.join(", ")}. No content transmitted.`);
  }));

  context.subscriptions.push(vscode.commands.registerCommand("aiPrivacyRouter.askLocal", async () => {
    const prompt = await vscode.window.showInputBox({prompt:"Ask local Qwen (never sent to cloud)",ignoreFocusOut:true});
    if (!prompt?.trim()) return;
    await runLocal(prompt);
  }));

  context.subscriptions.push(vscode.commands.registerCommand("aiPrivacyRouter.askLocalSelection", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      void vscode.window.showWarningMessage("Select code or document text first.");
      return;
    }
    const selected = editor.document.getText(editor.selection);
    const instruction = await vscode.window.showInputBox({
      prompt:"What should local Qwen do with the selected text?",
      value:"Explain the selected content",
      ignoreFocusOut:true
    });
    if (!instruction?.trim()) return;
    await runLocal(instruction + "\n\nSelected content:\n" + selected);
  }));
}

async function runLocal(prompt: string): Promise<void> {
  const decision = classifyInput({prompt, workspaceTrusted: vscode.workspace.isTrusted});
  // MVP: only local inference is implemented. Never auto-dispatch to cloud.
  if (decision.route === "blocked") {
    void vscode.window.showErrorMessage("Content blocked by privacy policy.");
    return;
  }
  const model = vscode.workspace.getConfiguration("aiPrivacyRouter").get<string>("ollamaModel","qwen2.5-coder:7b");
  try {
    const result = await vscode.window.withProgress({
      location:vscode.ProgressLocation.Notification,
      title:"AI Privacy Router: local Qwen"
    }, () => new LocalOllama({model}).generate(prompt));
    const document = await vscode.workspace.openTextDocument({content:result,language:"markdown"});
    await vscode.window.showTextDocument(document,{preview:true});
  } catch {
    void vscode.window.showErrorMessage("Local Ollama failed. No cloud fallback or external transfer was attempted.");
  }
}
export function deactivate(): void {}
