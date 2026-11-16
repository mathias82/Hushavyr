import * as vscode from "vscode";
import { classifyInput } from "./classifier";
import { LocalOllama } from "./ollama";
import { reviewPrompt, validateReview, formatReview } from "./review";
import { requestCloudOverride } from "./override";
import { writeAuditEvent } from "./audit";
import { randomUUID } from "node:crypto";

export function activate(context: vscode.ExtensionContext): void {
  // Remember the last non-empty editor selection when focus moves into Chat.
  let lastSelection: {uri: string; text: string} | undefined;
  let lastCodeEditor: vscode.TextEditor | undefined;
  const isCodeEditor = (editor: vscode.TextEditor): boolean => editor.document.uri.scheme === "file" && editor.document.languageId !== "markdown";
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => {
    if (editor && isCodeEditor(editor)) lastCodeEditor = editor;
  }));
  context.subscriptions.push(vscode.window.onDidChangeTextEditorSelection(event => {
    const text = event.textEditor.document.getText(event.selections[0]);
    if (text.trim()) lastSelection = {uri:event.textEditor.document.uri.toString(),text};
  }));
  const current = vscode.window.activeTextEditor;
  if (current && isCodeEditor(current)) lastCodeEditor = current;
  if (current && !current.selection.isEmpty) {
    lastSelection = {uri:current.document.uri.toString(),text:current.document.getText(current.selection)};
  }

  const participant = vscode.chat.createChatParticipant("ai-privacy-router.privacy", async (request, _context, stream, token) => {
    const instruction = (request.command === "review" && !request.prompt.trim() ? "Review the selected or attached code. Find verified bugs with severity, evidence, fixes, and regression tests." : request.prompt).trim();
    if (!instruction) {
      stream.markdown("Ask a question, e.g. `@ai-privacy Find bugs in the selected Java code`.");
      return;
    }
    // VS Code may change editor focus when Chat opens. Use the last non-empty selection.
    const editor = vscode.window.activeTextEditor;
    const activeSelection = editor && !editor.selection.isEmpty
      ? editor.document.getText(editor.selection) : undefined;
    const selected = activeSelection?.trim() ? activeSelection : lastSelection?.text;
    const selectedUri = activeSelection?.trim() ? editor?.document.uri.toString() : lastSelection?.uri;
    // Explicit Chat file attachments are not automatically part of request.prompt.
    const attachments: string[] = [];
    for (const ref of request.references) {
      const value = ref.value;
      const uri = value instanceof vscode.Uri ? value : value instanceof vscode.Location ? value.uri : undefined;
      if (!uri || (uri.scheme !== "file" && uri.scheme !== "untitled")) continue;
      try {
        const doc = await vscode.workspace.openTextDocument(uri);
        const content = value instanceof vscode.Location ? doc.getText(value.range) : doc.getText();
        if (content.trim()) attachments.push("Attached file: " + uri.toString() + "\n```\n" + content + "\n```");
      } catch {
        stream.markdown("Unable to read an attached file. Nothing was sent.");
        return;
      }
    }
    // Chat focus can clear activeTextEditor, including when the extension activates lazily.
    // Prefer the visible code editor, then the last editor, then the active text tab.
    let fallbackDoc: vscode.TextDocument | undefined;
    if (attachments.length === 0 && !selected?.trim()) {
      const visible = vscode.window.visibleTextEditors.filter(isCodeEditor);
      if (visible.length === 1) fallbackDoc = visible[0].document;
      else if (lastCodeEditor && isCodeEditor(lastCodeEditor)) fallbackDoc = lastCodeEditor.document;
      else {
        const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
        if (activeTab?.input instanceof vscode.TabInputText && activeTab.input.uri.scheme === "file") {
          try { fallbackDoc = await vscode.workspace.openTextDocument(activeTab.input.uri); } catch { /* no implicit fallback */ }
        }
      }
    }
    // If no explicit attachment or selection is available, use the last focused code editor.
    // Never scan the whole workspace; keep the context bounded to a single visible file.
    if (attachments.length === 0 && !selected?.trim() && fallbackDoc) {
      const doc = fallbackDoc;
      const text = doc.getText();
      if (text.trim() && Buffer.byteLength(text, "utf8") <= 100_000) {
        attachments.push("Open editor: " + doc.uri.toString() + "\n```" + doc.languageId + "\n" + text + "\n```");
      } else if (Buffer.byteLength(text, "utf8") > 100_000) {
        stream.markdown("The open file is larger than 100 KB. Select a smaller section. Nothing was sent.");
        return;
      }
    }
    const asksForSelection = /\b(select(?:ed|ion)?|this code|this file|highlighted)\b/i.test(instruction);
    if (asksForSelection && !selected?.trim() && attachments.length === 0) {
      stream.markdown("Select code or attach a file first, then ask `@ai-privacy` again. No content was sent.");
      return;
    }
    const sections = [instruction];
    if (attachments.length) sections.push(...attachments);
    else if (selected?.trim()) sections.push("Selected content (" + (selectedUri ?? "editor") + "):\n```\n" + selected + "\n```");
    const prompt = sections.join("\n\n");
    const decision = classifyInput({prompt,workspaceTrusted:vscode.workspace.isTrusted});
    if (decision.route === "blocked") {
      stream.markdown("Blocked by local privacy policy. Nothing was transmitted.");
      return;
    }
    stream.markdown("**Local Qwen** · Privacy route: `local` · Sensitivity: `" + decision.sensitivity + "`\n\n");
    const model = vscode.workspace.getConfiguration("aiPrivacyRouter").get<string>("ollamaModel","qwen2.5-coder:7b");
    const sourceCode = attachments.length ? attachments.join("\n\n") : (selected ?? "");
    const isReview = request.command === "review" || /\b(review|bugs?|vulnerabilit|issues?)\b/i.test(instruction);
    const localPrompt = isReview ? reviewPrompt(instruction, sourceCode) : prompt;
    try {
      if (token.isCancellationRequested) return;
      const client = new LocalOllama({model, timeoutMs: 180000});
      const result = await client.generate(localPrompt, {json: isReview});
      if (token.isCancellationRequested) return;
      if (!isReview) {
        stream.markdown(result);
      } else {
        let validated = validateReview(result, sourceCode);
        if (validated.error) {
          // One bounded local retry with format=json; never expose unverified raw findings.
          const retryPrompt = reviewPrompt(instruction, sourceCode) +
            "\n\nYour previous response was not valid JSON. Return ONLY one JSON object with a findings array, no prose or Markdown.";
          const retry = await client.generate(retryPrompt, {json: true});
          validated = validateReview(retry, sourceCode);
        }
        if (!token.isCancellationRequested) stream.markdown(formatReview(validated));
      }
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
