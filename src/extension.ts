import * as vscode from "vscode";
import { classifyInput } from "./classifier";
import { LocalOllama } from "./ollama";
import { requestCloudOverride } from "./override";
import { writeAuditEvent } from "./audit";
import { randomUUID } from "node:crypto";

export function activate(context: vscode.ExtensionContext): void {
  // Remember the last non-empty editor selection when focus moves into Chat.
  let lastSelection: {uri: string; text: string} | undefined;
  context.subscriptions.push(vscode.window.onDidChangeTextEditorSelection(event => {
    const text = event.textEditor.document.getText(event.selections[0]);
    if (text.trim()) lastSelection = {uri:event.textEditor.document.uri.toString(),text};
  }));
  const current = vscode.window.activeTextEditor;
  if (current && !current.selection.isEmpty) {
    lastSelection = {uri:current.document.uri.toString(),text:current.document.getText(current.selection)};
  }

  const participant = vscode.chat.createChatParticipant("ai-privacy-router.privacy", async (request, _context, stream, token) => {
    const instruction = request.prompt.trim();
    if (!instruction) {
      stream.markdown("Ask a question, e.g. `@privacy Find bugs in the selected Java code`.");
      return;
    }
    // VS Code may change editor focus when Chat opens. Use the last non-empty selection.
    const editor = vscode.window.activeTextEditor;
    const activeSelection = editor && !editor.selection.isEmpty
      ? editor.document.getText(editor.selection) : undefined;
    const selected = activeSelection?.trim() ? activeSelection : lastSelection?.text;
    const selectedUri = activeSelection?.trim() ? editor?.document.uri.toString() : lastSelection?.uri;
    const asksForSelection = /\\b(select(?:ed|ion)?|this code|this file|highlighted)\\b/i.test(instruction);
    if (asksForSelection && !selected?.trim()) {
      stream.markdown("Select code in an editor first, then ask `@privacy` again. No content was sent.");
      return;
    }
    const prompt = selected?.trim()
      ? instruction + "\\n\\nSelected content (" + (selectedUri ?? "editor") + "):\\n```\\n" + selected + "\\n```"
      : instruction;
    const decision = classifyInput({prompt,workspaceTrusted:vscode.workspace.isTrusted});
    if (decision.route === "blocked") {
      stream.markdown("Blocked by local privacy policy. Nothing was transmitted.");
      return;
    }
    stream.markdown("**Local Qwen** · Privacy route: `local` · Sensitivity: `" + decision.sensitivity + "`\\n\\n");
    const model = vscode.workspace.getConfiguration("aiPrivacyRouter").get<string>("ollamaModel","qwen2.5-coder:7b");
    const reviewPrompt = "You are a cautious senior Java reviewer. For each verified bug give severity, evidence tied to the provided code, a concrete fix and a regression test. Distinguish definite bugs from hypotheses. Do not invent other files or test results.\\n\\n" + prompt;
    try {
      if (token.isCancellationRequested) return;
      const result = await new LocalOllama({model}).generate(reviewPrompt);
      if (!token.isCancellationRequested) stream.markdown(result);
    } catch {
      stream.markdown("Local Ollama unavailable or request failed. **No cloud fallback.** Start it with `npm run ai:serve`.");
    }
  });
  context.subscriptions.push(participant);

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

  context.subscriptions.push(vscode.commands.registerCommand("aiPrivacyRouter.reviewCloudOverride", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      void vscode.window.showWarningMessage("Select content to review first.");
      return;
    }
    const selected = editor.document.getText(editor.selection);
    const input = {prompt:selected,workspaceTrusted:vscode.workspace.isTrusted};
    const decision = classifyInput(input);
    const answer = await vscode.window.showWarningMessage(
      "Cloud transfer review only. Destination: Anthropic Sonnet (NOT CONNECTED). " +
      "Sensitivity: " + decision.sensitivity + ". Reasons: " + decision.reasons.join(", ") +
      ". Selected content could leave your device if a cloud adapter is enabled later. No transfer will happen now.",
      {modal:true}, "Review override"
    );
    if (answer !== "Review override") return;
    const reason = await vscode.window.showInputBox({prompt:"Why is this content safe for external processing? (not logged verbatim)",ignoreFocusOut:true});
    if (!reason?.trim()) return;
    const confirmation = await vscode.window.showWarningMessage(
      "Confirm review of possible future external processing by Anthropic Sonnet. No data will be sent in this MVP.",
      {modal:true}, "Confirm review"
    );
    if (confirmation !== "Confirm review") return;
    const result = requestCloudOverride(input,
      {cloudEnabled:true,allowOverrides:true},
      {reason,confirmedCloudTransfer:true});
    const event = {
      action: result.allowed ? "cloud-approval" as const : "cloud-denial" as const,
      actorId:"local-user",provider:"anthropic",model:"sonnet",
      requestId:randomUUID(),policyVersion:"mvp-v1",
      reasonCode:result.allowed ? "manual-review" : "policy-denied",
      outcome:result.allowed ? "approved" as const : "denied" as const
    };
    try {
      await writeAuditEvent(context.globalStorageUri.fsPath + "/cloud-review.jsonl",event);
    } catch {
      void vscode.window.showErrorMessage("Audit write failed. Approval is not recorded; cloud remains disabled.");
      return;
    }
    void vscode.window.showInformationMessage(result.allowed
      ? "Review approved and audited locally. Cloud dispatch is NOT implemented."
      : "Override denied and audited: " + result.reasons.join(", "));
  }));

  context.subscriptions.push(vscode.commands.registerCommand("aiPrivacyRouter.privacyPreview", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      void vscode.window.showWarningMessage("Select text for privacy review.");
      return;
    }
    const decision = classifyInput({prompt:editor.document.getText(editor.selection),workspaceTrusted:vscode.workspace.isTrusted});
    const report = [
      "# AI Privacy Router — Privacy Preview", "",
      "**Route:** " + decision.route,
      "**Sensitivity:** " + decision.sensitivity,
      "**Task:** " + decision.task,
      "**Workspace trusted:** " + vscode.workspace.isTrusted,
      "**Cloud dispatch:** Disabled in MVP", "",
      "## Detection reasons",
      ...decision.reasons.map(reason => "- " + reason), "",
      "No selected content is included in this report.",
      "Classification is heuristic and does not certify that content is safe to share.",
      "No cloud approval or transfer was performed."
    ].join("\n");
    const document = await vscode.workspace.openTextDocument({content:report,language:"markdown"});
    await vscode.window.showTextDocument(document,{preview:true});
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
