import * as vscode from "vscode";
import {runnerFor} from "./proofTarget";
import {configuredClient} from "../model/model";
import {findingFix, fitFix, fixPrompt, fixWindow, parseReplacement, parseReviewMessage, replacementSchema} from "./fixEdit";
import {EXPLAIN_FINDING, FindingArg, pickFinding} from "../explainFinding";
import {acceptManifestEdit, dependencyEditInstruction, parseDependencyFinding, planDependencyFix, resolveManifest} from "../deps/dependencyAudit";
import {editPrompt, editSchema, parseEdit} from "./codeEdit";

export const FIX_FINDING = "aiPrivacyRouter.fixFinding";
const PREVIEW_SCHEME = "hushavyr-fix";
const previews = new Map<string, string>();
let previewCount = 0;

/** Local model rewrites a few lines for a finding (/review marker, scanner, data flow or secret); the user sees a diff and must approve. */
export async function applyReviewFix(uriText: string, markedLine: number, message: string): Promise<void> {
  const dependency = parseDependencyFinding(message);
  if (dependency) return applyDependencyFix(uriText, message);
  const parsed = findingFix(message);
  if (!parsed) {
    void vscode.window.showInformationMessage("Hushavyr: this finding has no automatic fix.");
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
  const fit = replacement ? fitFix(original, replacement, markedLine - window.start) : undefined;
  if (!replacement || !fit) {
    void vscode.window.showInformationMessage("Hushavyr: the local model did not produce a safe automatic fix. Apply the suggestion manually.");
    return;
  }
  const start = window.start + fit.start, end = window.start + fit.end;
  const range = new vscode.Range(start, 0, end, original[fit.end].length);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(doc.uri, range, fit.text);
  const full = doc.getText().split(/\r?\n/);
  full.splice(start, fit.end - fit.start + 1, ...fit.text.split("\n"));
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

/** True when local AI can propose a change for this finding (code fix or dependency upgrade). */
export function canFix(message: string): boolean {
  const dependency = parseDependencyFinding(message);
  return dependency ? !!dependency.fixed : !!findingFix(message);
}

/** Shows a proposed full-file change as a diff and applies it (unsaved) only after approval. */
async function proposeFileChange(doc: vscode.TextDocument, updated: string, title: string, after = ""): Promise<boolean> {
  const name = doc.uri.path.split("/").pop() ?? "file";
  const preview = vscode.Uri.from({scheme: PREVIEW_SCHEME, path: "/" + ++previewCount + "/" + name});
  previews.set(preview.toString(), updated);
  await vscode.commands.executeCommand("vscode.diff", doc.uri, preview, "Hushavyr fix: " + name + " (current ↔ proposed)", {preview: true});
  const answer = await vscode.window.showInformationMessage("Hushavyr: apply the fix for \u201c" + title.slice(0, 80) + "\u201d? Review the diff first; the file is not saved until you save it.",
    {modal: false}, "Apply fix", "Discard");
  const tabs = vscode.window.tabGroups?.all.flatMap(group => group.tabs).filter(tab => tab.input instanceof vscode.TabInputTextDiff && tab.input.modified.toString() === preview.toString()) ?? [];
  if (tabs.length) await vscode.window.tabGroups.close(tabs);
  previews.delete(preview.toString());
  if (answer !== "Apply fix") return false;
  const edit = new vscode.WorkspaceEdit();
  edit.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), updated);
  if (!await vscode.workspace.applyEdit(edit)) return false;
  await vscode.window.showTextDocument(doc);
  void vscode.window.showInformationMessage("Hushavyr: fix applied (unsaved)." + after + " Undo with Cmd/Ctrl+Z; re-run the scan to confirm.");
  return true;
}

/** Dependency CVE: upgrade it in the manifest (deterministic bump, else local AI edit), shown as a diff to approve. */
export async function applyDependencyFix(uriText: string, message: string): Promise<void> {
  const finding = parseDependencyFinding(message);
  const uri = vscode.Uri.parse(uriText);
  if (!finding || uri.scheme !== "file") return;
  const manifest = await resolveManifest(uri.fsPath);
  const plan = planDependencyFix(uri.fsPath, finding, manifest.text, manifest.path);
  if (!plan) {
    void vscode.window.showInformationMessage("Hushavyr: " + finding.pkg + " has no fixed version yet. Remove or replace the package, or dismiss the finding if it does not apply.");
    return;
  }
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(plan.manifest));
  const original = doc.getText();
  const after = plan.then ? " Then run `" + plan.then + "` to update the lockfile." : "";
  if (plan.updated !== undefined) { await proposeFileChange(doc, plan.updated, finding.id + " " + finding.pkg, after); return; }
  if (!vscode.workspace.isTrusted || vscode.env?.remoteName) {
    void vscode.window.showInformationMessage("Hushavyr: " + plan.advice.replace(/`/g, ""));
    return;
  }
  const client = configuredClient(vscode.workspace.getConfiguration("aiPrivacyRouter"));
  const path = vscode.workspace.asRelativePath(doc.uri, false);
  let updated: string | undefined;
  try {
    updated = await vscode.window.withProgress({location: vscode.ProgressLocation.Notification, title: "Hushavyr: preparing dependency fix locally", cancellable: true}, async (_p, token) => {
      const controller = new AbortController();
      token.onCancellationRequested(() => controller.abort());
      await client.ensureInstalled(controller.signal);
      return parseEdit(await client.generate(editPrompt(path, doc.languageId, original, dependencyEditInstruction(finding, plan)), {schema: editSchema, signal: controller.signal}), original);
    });
  } catch {
    void vscode.window.showErrorMessage("Hushavyr: local fix failed or was cancelled. Run Hushavyr: Setup if Ollama is not running. No cloud fallback.");
    return;
  }
  if (!updated || !acceptManifestEdit(plan.manifest, original, updated, finding)) {
    void vscode.window.showInformationMessage("Hushavyr: the local model did not produce a safe change. Do it manually: " + plan.advice.replace(/`/g, ""));
    return;
  }
  await proposeFileChange(doc, updated, finding.id + " " + finding.pkg, after);
}

/** Pick a finding of the latest report (or under the cursor), then fix, explain or dismiss it. */
export async function actOnFinding(arg?: FindingArg): Promise<void> {
  const finding = arg ?? await pickFinding("Which finding? Next: fix with local AI, explain or dismiss");
  if (!finding) return;
  const fix = canFix(finding.message);
  const choice = await vscode.window.showQuickPick([
    ...(fix ? [{label: "$(wrench) Fix with local AI", description: "shows a diff to approve", id: "fix"}] : []),
    {label: "$(comment-discussion) Explain (local AI)", description: "", id: "explain"},
    {label: "$(eye-closed) Dismiss: not a real issue", description: "hidden for the team via .hushavyr/dismissed.json", id: "dismiss"}
  ], {placeHolder: finding.message.slice(0, 120)});
  if (choice?.id === "fix") await applyReviewFix(finding.uri, finding.line - 1, finding.message);
  else if (choice?.id === "explain") await vscode.commands.executeCommand(EXPLAIN_FINDING, finding);
  else if (choice?.id === "dismiss") await vscode.commands.executeCommand("aiPrivacyRouter.dismissFinding", finding.uri, finding.line - 1, finding.message);
}

export function registerApplyFix(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(PREVIEW_SCHEME, {provideTextDocumentContent: uri => previews.get(uri.toString()) ?? ""}));
  context.subscriptions.push(vscode.commands.registerCommand("aiPrivacyRouter.applyReviewFix",
    (uri: string, line: number, message: string) => applyReviewFix(uri, line, message)));
  // Chat and palette entry: pick a finding of the latest report (or under the cursor), then propose a fix.
  context.subscriptions.push(vscode.commands.registerCommand(FIX_FINDING, (arg?: FindingArg) => actOnFinding(arg)));
  context.subscriptions.push(vscode.languages.registerCodeActionsProvider([{scheme: "file"}, {scheme: "untitled"}], {
    provideCodeActions(document, _range, ctx) {
      return ctx.diagnostics.filter(d => d.source === "Hushavyr").map(d => {
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
        dismiss.command = {command: "aiPrivacyRouter.dismissFinding", title: "Dismiss", arguments: [document.uri.toString(), d.range.start.line, d.message]};
        const shared = document.uri.scheme === "file" ? [dismiss] : [];
        const fixes = canFix(d.message) ? [action] : [];
        if (!parseReviewMessage(d.message)) return [...fixes, ...shared];
        return document.uri.scheme === "file" && runnerFor(document.uri.fsPath) ? [...fixes, prove, ...shared] : [...fixes, ...shared];
      }).flat();
    }
  }, {providedCodeActionKinds: [vscode.CodeActionKind.QuickFix]}));
}
