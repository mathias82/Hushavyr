import {homedir} from "node:os";
import * as vscode from "vscode";
import {registerVerifiedFix} from "./fixAgent";
import { classifyInput } from "./classifier";
import { createAutoPrompt, formatRouted } from "./autoPrompt";
import { LocalOllama } from "./ollama";
import { formatReview } from "./review";
import { runLocalReview } from "./localReview";
import { reviewOverride } from "./overrideFlow";
import { writeRetainedAuditEvent } from "./audit";
import { ReviewSource, sourcePrompt, validateContext } from "./context";
import { runRegressionTests, testProfiles, TestProfile, formatTestReceipt } from "./regression";

export function activate(context: vscode.ExtensionContext): void {
  registerVerifiedFix(context);
  for (const task of [
    {id: "startOllama", title: "Ollama server", args: ["serve"]},
    {id: "downloadOllamaModel", title: "Qwen model download", args: ["pull", "qwen2.5-coder:7b"]}
  ]) {
    context.subscriptions.push(vscode.commands.registerCommand("aiPrivacyRouter." + task.id, async () => {
      if (!vscode.workspace.isTrusted || vscode.env.remoteName) {
        await vscode.window.showInformationMessage("Open a trusted local VS Code window to set up Ollama.");
        return;
      }
      const command = ["ollama", ...task.args].join(" ");
      const action = await vscode.window.showInformationMessage("Run " + command + "?", {modal: true}, "Run in Terminal");
      if (action !== "Run in Terminal") return;
      const terminal = vscode.window.createTerminal({name: "Hushavyr: " + task.title, cwd: homedir()});
      terminal.show();
      terminal.sendText(command);
    }));
  }
  context.subscriptions.push(vscode.commands.registerCommand("aiPrivacyRouter.installOllama", async () => {
    if (!vscode.workspace.isTrusted || vscode.env.remoteName) {
      await vscode.window.showInformationMessage("Open a trusted local VS Code window to install Ollama.");
      return;
    }
    const commands = {
      darwin: "brew install ollama",
      win32: "winget install --id Ollama.Ollama --exact",
      linux: "curl -fsSL https://ollama.com/install.sh | sh"
    };
    const platform = process.platform;
    if (platform !== "darwin" && platform !== "win32" && platform !== "linux") {
      await vscode.env.openExternal(vscode.Uri.parse("https://ollama.com/download"));
      return;
    }
    const command = commands[platform];
    const action = await vscode.window.showInformationMessage("Run the Ollama installer in the VS Code terminal?",
      {modal: true, detail: command}, "Run installer", "Open download page");
    if (action === "Open download page") {
      await vscode.env.openExternal(vscode.Uri.parse("https://ollama.com/download"));
    } else if (action === "Run installer") {
      const terminal = vscode.window.createTerminal({name: "Hushavyr: Ollama setup", cwd: homedir()});
      terminal.show();
      terminal.sendText(command);
    }
  }));
  // Remember the last non-empty editor selection when focus moves into Chat.
  let lastSelection: {uri: string; text: string; startLine: number} | undefined;
  let lastCodeEditor: vscode.TextEditor | undefined;
  const isCodeEditor = (editor: vscode.TextEditor): boolean => editor.document.uri.scheme === "file" && editor.document.languageId !== "markdown";
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => {
    if (editor && isCodeEditor(editor)) lastCodeEditor = editor;
  }));
  context.subscriptions.push(vscode.window.onDidChangeTextEditorSelection(event => {
    const text = event.textEditor.document.getText(event.selections[0]);
    if (text.trim()) lastSelection = {uri:event.textEditor.document.uri.toString(),text,startLine:event.selections[0].start.line+1};
  }));
  const current = vscode.window.activeTextEditor;
  if (current && isCodeEditor(current)) lastCodeEditor = current;
  if (current && !current.selection.isEmpty) {
    lastSelection = {uri:current.document.uri.toString(),text:current.document.getText(current.selection),startLine:current.selection.start.line+1};
  }

  context.subscriptions.push(vscode.commands.registerCommand("aiPrivacyRouter.runTests", async () => {
    const receipt = await runWorkspaceTests();
    if (!receipt) return;
    const document = await vscode.workspace.openTextDocument({content: formatTestReceipt(receipt), language: "markdown"});
    await vscode.window.showTextDocument(document, {preview: true});
  }));

  const autoPrompt = createAutoPrompt(context);
  context.subscriptions.push(vscode.commands.registerCommand("aiPrivacyRouter.askAuto", async () => {
    const prompt = await vscode.window.showInputBox({
      prompt: "Route a typed prompt only. No editor contents, files or history are added.",
      ignoreFocusOut: true
    });
    if (!prompt?.trim()) return;
    try {
      const result = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification, title: "Hushavyr", cancellable: true
      }, (_, token) => autoPrompt(prompt, token));
      if (result.reason === "cancelled") return;
      const document = await vscode.workspace.openTextDocument({content: formatRouted(result), language: "markdown"});
      await vscode.window.showTextDocument(document, {preview: true});
    } catch {
      void vscode.window.showErrorMessage("AI request stopped. No automatic provider fallback; inspect local setup and audit availability.");
    }
  }));

  // Standalone local commands remain available when built-in Chat/Copilot is disabled.
  if (!vscode.workspace.getConfiguration("chat").get<boolean>("disableAIFeatures", false)) {
  const participant = vscode.chat.createChatParticipant("ai-privacy-router.privacy", async (request, _context, stream, token) => {
    if (request.command === "auto" && request.references.length === 0) {
      try {
        const result = await autoPrompt(request.prompt, token);
        if (!token.isCancellationRequested) stream.markdown(formatRouted(result));
      } catch {
        if (!token.isCancellationRequested) stream.markdown("AI request stopped. No automatic provider fallback; check provider setup and audit availability.");
      }
      return;
    }
    if (request.command === "auto") stream.markdown("Attached context stays local; Copilot is not considered for this request.\n\n");
    if (request.command === "test") {
      const receipt = await runWorkspaceTests(token);
      if (receipt && !token.isCancellationRequested) stream.markdown(formatTestReceipt(receipt));
      return;
    }
    const instruction = (request.command === "review" && !request.prompt.trim() ? "Review the selected or attached code. Find concrete potential bugs with severity, evidence, fixes, and regression tests." : request.prompt).trim();
    if (!instruction) {
      stream.markdown("Ask a question, e.g. `@ai-privacy Find bugs in the selected code`.");
      return;
    }
    // VS Code may change editor focus when Chat opens. Use the last non-empty selection.
    const editor = vscode.window.activeTextEditor;
    const activeSelection = editor && !editor.selection.isEmpty
      ? editor.document.getText(editor.selection) : undefined;
    const selected = activeSelection?.trim() ? activeSelection : lastSelection?.text;
    const selectedUri = activeSelection?.trim() ? editor?.document.uri.toString() : lastSelection?.uri;
    // Explicit Chat file attachments are not automatically part of request.prompt.
    const attachments: ReviewSource[] = [];
    for (const ref of request.references) {
      const value = ref.value;
      const uri = value instanceof vscode.Uri ? value : value instanceof vscode.Location ? value.uri : undefined;
      if (!uri || (uri.scheme !== "file" && uri.scheme !== "untitled")) {
        stream.markdown("An attached context item cannot be inspected. Remove it or attach readable local files. Nothing was sent.");
        return;
      }
      try {
        const doc = await vscode.workspace.openTextDocument(uri);
        const content = value instanceof vscode.Location ? doc.getText(value.range) : doc.getText();
        if (content.trim()) {
          const path = uri.toString();
          if (!attachments.some(s => s.path === path)) attachments.push({path, text: content,
            startLine: value instanceof vscode.Location ? value.range.start.line + 1 : 1});
        }
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
        attachments.push({path: doc.uri.toString(), text});
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
    const sources: ReviewSource[] = attachments.length ? attachments : selected?.trim()
      ? [{path: selectedUri ?? "selection", text: selected,
          startLine: activeSelection?.trim() ? editor!.selection.start.line + 1 : lastSelection?.startLine}] : [];
    try { validateContext(instruction, sources); }
    catch (error) { stream.markdown(error instanceof Error ? error.message : "Invalid context."); return; }
    const prompt = instruction + (sources.length ? "\n\n" + sourcePrompt(sources) : "");
    const decision = classifyInput({prompt: instruction,
      attachments: sources.map(s => ({path: s.path, content: s.text})), workspaceTrusted: vscode.workspace.isTrusted});
    if (decision.route === "blocked") {
      stream.markdown("Blocked by local privacy policy. Nothing was transmitted.");
      return;
    }
    stream.markdown("**Local Qwen** · Privacy route: `local` · Sensitivity: `" + decision.sensitivity + "`\n\n");
    const model = vscode.workspace.getConfiguration("aiPrivacyRouter").get<string>("ollamaModel","qwen2.5-coder:7b");

    const isReview = request.command === "review" || /\b(review|bugs?|vulnerabilit|issues?)\b/i.test(instruction);
    if (isReview && !sources.length) {
      stream.markdown("Select code or attach local files first. Nothing was sent.");
      return;
    }
    const controller = new AbortController();
    const subscription = token.onCancellationRequested(() => controller.abort());
    try {
      if (token.isCancellationRequested) return;
      const config = vscode.workspace.getConfiguration("aiPrivacyRouter");
      const endpoint = config.get<string>("ollamaEndpoint", "http://127.0.0.1:11434");
      const timeoutMs = config.get<number>("timeoutSeconds", 180) * 1000;
      const client = new LocalOllama({model, endpoint, timeoutMs});
      await client.ensureAvailable(controller.signal);
      const withSignal = (local: LocalOllama) => ({generate: (text: string, options = {}) =>
        local.generate(text, {...options, signal: controller.signal})});
      if (!isReview) {
        const result = await client.generate(prompt, {signal: controller.signal});
        if (!token.isCancellationRequested) stream.markdown(result);
      } else {
        const verifierModel = config.get<string>("verifierModel", "").trim() || model;
        const verifier = verifierModel === model ? client : new LocalOllama({model: verifierModel, endpoint, timeoutMs});
        // Each pass has a fresh prompt; the same model may serve both passes.
        const validated = await runLocalReview(withSignal(client), instruction, sources,
          () => token.isCancellationRequested, withSignal(verifier));
        if (validated && !token.isCancellationRequested) stream.markdown(formatReview(validated));
      }
    } catch {
      if (!token.isCancellationRequested) stream.markdown("Local request failed. Check the Ollama endpoint and installed model with `npm run ai:serve`. **No cloud fallback.**");
    } finally { subscription.dispose(); }

  });
  context.subscriptions.push(participant);
  }

  context.subscriptions.push(vscode.commands.registerCommand("aiPrivacyRouter.classifySelection", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      void vscode.window.showWarningMessage("Select text in an editor first.");
      return;
    }
    const selected = editor.document.getText(editor.selection);
    const decision = classifyInput({prompt: selected, workspaceTrusted: vscode.workspace.isTrusted});
    void vscode.window.showInformationMessage(`Hushavyr: ${decision.route}; ${decision.reasons.join(", ")}. No content transmitted.`);
  }));

  context.subscriptions.push(vscode.commands.registerCommand("aiPrivacyRouter.reviewCloudOverride", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      void vscode.window.showWarningMessage("Select content to review first.");
      return;
    }
    const selected = editor.document.getText(editor.selection);
    const input = {prompt: "Review selected content for possible external processing",
      selectedCode: [{path: editor.document.uri.toString(), content: selected}], workspaceTrusted: vscode.workspace.isTrusted};
    const config = vscode.workspace.getConfiguration("aiPrivacyRouter");
    // This legacy command is review-only; it cannot dispatch to Copilot or any other provider.
    const preview = await vscode.workspace.openTextDocument({content: JSON.stringify(input, null, 2), language: "json"});
    await vscode.window.showTextDocument(preview, {preview: true, viewColumn: vscode.ViewColumn.Beside});
    try {
      const outcome = await reviewOverride(input,
        {cloudEnabled: true, allowOverrides: true,
          mandatoryLocalOnly: config.get<boolean>("mandatoryLocalOnly", false),
          requireReviewer: config.get<boolean>("requireReviewer", false)}, {
          confirmWarning: async () => await vscode.window.showWarningMessage(
            "Review only: Anthropic Sonnet (NOT CONNECTED). The local preview shows the entire candidate context: " +
            Buffer.byteLength(selected, "utf8") + " bytes from one selected file. Nothing will be sent.",
            {modal: true}, "Review override") === "Review override",
          justification: async () => vscode.window.showInputBox({prompt: "Why is this content safe for external processing? (not logged verbatim)", ignoreFocusOut: true}),
          confirmReview: async () => await vscode.window.showWarningMessage(
            "Record this review locally? This does not enable cloud transfer.", {modal: true}, "Confirm review") === "Confirm review"
          // No verified reviewer identity provider is connected. requireReviewer therefore denies approval.
        }, event => writeRetainedAuditEvent(context.globalStorageUri.fsPath + "/audit", event));
      void vscode.window.showInformationMessage(outcome === "approved"
        ? "Review approved and audited locally. This command never sends content."
        : "Review " + outcome + " and audited locally. Nothing was sent.");
    } catch {
      void vscode.window.showErrorMessage("Audit write failed. No approval or transfer is permitted.");
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand("aiPrivacyRouter.privacyPreview", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      void vscode.window.showWarningMessage("Select text for privacy review.");
      return;
    }
    const decision = classifyInput({prompt:editor.document.getText(editor.selection),workspaceTrusted:vscode.workspace.isTrusted});
    const report = [
      "# Hushavyr — Privacy Preview", "",
      "**Route:** " + decision.route,
      "**Sensitivity:** " + decision.sensitivity,
      "**Task:** " + decision.task,
      "**Workspace trusted:** " + vscode.workspace.isTrusted,
      "**Cloud dispatch:** This command is local-only; optional public-prompt routing is configured separately.", "",
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
  try { validateContext(prompt, []); }
  catch {
    void vscode.window.showWarningMessage("Context exceeds 20 KB. Select less content.");
    return;
  }
  const decision = classifyInput({prompt, workspaceTrusted: vscode.workspace.isTrusted});
  // This standalone local command never selects or dispatches to a cloud provider.
  if (decision.route === "blocked") {
    void vscode.window.showErrorMessage("Content blocked by privacy policy.");
    return;
  }
  const model = vscode.workspace.getConfiguration("aiPrivacyRouter").get<string>("ollamaModel","qwen2.5-coder:7b");
  try {
    const result = await vscode.window.withProgress({
      location:vscode.ProgressLocation.Notification,
      title:"Hushavyr: local Qwen"
    }, async () => {
      const config = vscode.workspace.getConfiguration("aiPrivacyRouter");
      const client = new LocalOllama({model, endpoint: config.get<string>("ollamaEndpoint"),
        timeoutMs: config.get<number>("timeoutSeconds", 180) * 1000});
      await client.ensureAvailable();
      return client.generate(prompt);
    });
    const document = await vscode.workspace.openTextDocument({content:result,language:"markdown"});
    await vscode.window.showTextDocument(document,{preview:true});
  } catch {
    void vscode.window.showErrorMessage("Local Ollama failed. No cloud fallback or external transfer was attempted.");
  }
}
async function runWorkspaceTests(externalToken?: vscode.CancellationToken) {
  if (externalToken?.isCancellationRequested) return;
  if (!vscode.workspace.isTrusted) {
    void vscode.window.showWarningMessage("Trust this workspace before running its tests.");
    return;
  }
  const folder = await vscode.window.showWorkspaceFolderPick({placeHolder: "Choose the project whose existing tests will run"});
  if (!folder || folder.uri.scheme !== "file") return;
  const items = (Object.keys(testProfiles) as TestProfile[]).map(profile => ({label: testProfiles[profile].label, profile}));
  const choice = await vscode.window.showQuickPick(items, {placeHolder: "Run existing tests locally (project scripts may execute code)"});
  if (!choice) return;
  return vscode.window.withProgress({location: vscode.ProgressLocation.Notification,
    title: "Running " + choice.label, cancellable: true}, async (_, token) => {
    const controller = new AbortController();
    const subscription = token.onCancellationRequested(() => controller.abort());
    const externalSubscription = externalToken?.onCancellationRequested(() => controller.abort());
    if (token.isCancellationRequested || externalToken?.isCancellationRequested) controller.abort();
    try {
      return await runRegressionTests({cwd: folder.uri.fsPath, profile: choice.profile,
        trusted: vscode.workspace.isTrusted, signal: controller.signal});
    } catch {
      void vscode.window.showErrorMessage("Unable to run the existing local test suite. Check the selected project and runner.");
      return;
    } finally { subscription.dispose(); externalSubscription?.dispose(); }
  });
}
export function deactivate(): void {}

