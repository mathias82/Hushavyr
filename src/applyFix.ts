import * as vscode from "vscode";
import {runnerFor} from "./proofTarget";
import {configuredClient} from "./model";
import {findingFix, fixPrompt, fixWindow, isPlausibleFix, parseReplacement, parseReviewMessage, replacementSchema} from "./fixEdit";
import {pickFinding} from "./explainFinding";

export const FIX_FINDING = "aiPrivacyRouter.fixFinding";
const PREVIEW_SCHEME = "hushavyr-fix";
const previews = new Map<string, string>();
let previewCount = 0;

/** Local model rewrites a few lines for a finding (/review marker, scanner, data flow or secret); the user sees a diff and must approve. */
export async function applyReviewFix(uriText: string, markedLine: number, message: string): Promise<void> {
  const parsed = findingFix(message);
  if (!parsed) {
    void vscode.window.showInformationMessage("Hushavyr: this finding has no code fix; dependency vulnerabilities are fixed by upgrading the package (quick fix in the Problems panel).");
    return;
  }
  if (!vscode.workspace.isTrusted || vscode.env?.remoteName) {
    void vscode.window.showInformationMessage("Hushavyr: open a trusted local VS Code window to fix findings with local AI.");
    return;
  }
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(uriText));
  const window = fixWindow(doc.lineCount, markedLine);
  const original = Array.from({length: window.end - window.start + 1}, (_, i) => doc.lineAt(window.start + i).text);
  const config = vscode.workspace.getConfiguration("aiPrivacyRouter");
  const client = configuredClient(config);
  let replacement: string | undefined;
  try {
    replacement = await vscode.window.withProgress({location: vscode.ProgressLocation.Notification, title: "Hushavyr: preparing fix locally", cancellable: true}, async (_p, token) => {
      const controller = new AbortController();
      token.onCancellationRequested(() => controller.abort());
      await client.ensureInstalled(controller.signal);
      return parseReplacement(await client.generate(fixPrompt(vscode.workspace.asRelativePath(doc.uri), doc.languageId, original, window.start + 1, parsed.title, parsed.fix),
        {schema: replacementSchema, signal: controller.signal}));
    });
  } catch {
    void vscode.window.showErrorMessage("Hushavyr: local fix failed or was cancelled. Run Hushavyr: Setup if Ollama is not running. No cloud fallback.");
    return;
  }
  if (!replacement || !isPlausibleFix(original, replacement)) {
    void vscode.window.showInformationMessage("Hushavyr: the local model did not produce a safe automatic fix. Apply the suggestion manually.");
    return;
  }
  const range = new vscode.Range(window.start, 0, window.end, original[original.length - 1].length);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(doc.uri, range, replacement);
  const full = doc.getText().split(/\r?\n/);
  full.splice(window.start, original.length, ...replacement.split("\n"));
  // A read-only virtual document: discarding the preview never asks to save an untitled file.
  const name = doc.uri.path.split("/").pop() ?? "file";
  const preview = vscode.Uri.from({scheme: PREVIEW_SCHEME, path: "/" + ++previewCount + "/" + name});
  previews.set(preview.toString(), full.join("\n"));
  await vscode.commands.executeCommand("vscode.diff", doc.uri, preview, "Hushavyr fix: " + name + " (current ↔ proposed)", {preview: true});
  const answer = await vscode.window.showInformationMessage("Hushavyr: apply the local AI fix for \u201c" + parsed.title.slice(0, 80) + "\u201d? Review the diff first; the file is not saved until you save it.",
    {modal: false}, "Apply fix", "Discard");
  const tabs = vscode.window.tabGroups?.all.flatMap(group => group.tabs).filter(tab => tab.input instanceof vscode.TabInputTextDiff && tab.input.modified.toString() === preview.toString()) ?? [];
  if (tabs.length) await vscode.window.tabGroups.close(tabs);
  previews.delete(preview.toString());
  if (answer !== "Apply fix") return;
  if (await vscode.workspace.applyEdit(edit)) {
    await vscode.window.showTextDocument(doc, {selection: new vscode.Range(window.start, 0, window.start, 0)});
    void vscode.window.showInformationMessage("Hushavyr: fix applied (unsaved). Undo with Cmd/Ctrl+Z; re-run the scan to confirm.");
  }
}

export function registerApplyFix(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(PREVIEW_SCHEME, {provideTextDocumentContent: uri => previews.get(uri.toString()) ?? ""}));
  context.subscriptions.push(vscode.commands.registerCommand("aiPrivacyRouter.applyReviewFix",
    (uri: string, line: number, message: string) => applyReviewFix(uri, line, message)));
  // Chat and palette entry: pick a finding of the latest report (or under the cursor), then propose a fix.
  context.subscriptions.push(vscode.commands.registerCommand(FIX_FINDING, async () => {
    const finding = await pickFinding("Which finding should local AI fix?", f => !!findingFix(f.message));
    if (finding) await applyReviewFix(finding.uri, finding.line - 1, finding.message);
  }));
  context.subscriptions.push(vscode.languages.registerCodeActionsProvider([{scheme: "file"}, {scheme: "untitled"}], {
    provideCodeActions(document, _range, ctx) {
      return ctx.diagnostics.filter(d => d.source === "Hushavyr" && findingFix(d.message)).map(d => {
        const action = new vscode.CodeAction("Hushavyr: Fix with local AI (shows a diff to approve)", vscode.CodeActionKind.QuickFix);
        action.isPreferred = true;
        action.diagnostics = [d];
        action.command = {command: "aiPrivacyRouter.applyReviewFix", title: "Propose fix",
          arguments: [document.uri.toString(), d.range.start.line, d.message]};
        const prove = new vscode.CodeAction("Hushavyr: prove with a failing test (offline Docker)", vscode.CodeActionKind.QuickFix);
        prove.diagnostics = [d];
        prove.command = {command: "aiPrivacyRouter.verifyLocalFix", title: "Prove with a test",
          arguments: [{file: document.uri.toString(), message: d.message}]};
        const dismiss = new vscode.CodeAction("Hushavyr: not a real issue (hide for the team)", vscode.CodeActionKind.QuickFix);
        dismiss.diagnostics = [d];
        dismiss.command = {command: "aiPrivacyRouter.dismissFinding", title: "Dismiss", arguments: [document.uri.toString(), d.range.start.line]};
        const shared = document.uri.scheme === "file" ? [dismiss] : [];
        if (!parseReviewMessage(d.message)) return [action];
        return document.uri.scheme === "file" && runnerFor(document.uri.fsPath) ? [action, prove, ...shared] : [action, ...shared];
      }).flat();
    }
  }, {providedCodeActionKinds: [vscode.CodeActionKind.QuickFix]}));
}
