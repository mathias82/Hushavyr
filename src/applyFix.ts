import * as vscode from "vscode";
import {runnerFor} from "./proofTarget";
import {configuredModel} from "./model";
import {LocalOllama} from "./ollama";
import {fixPrompt, fixWindow, isPlausibleFix, parseReplacement, parseReviewMessage, replacementSchema} from "./fixEdit";

/** Local model rewrites a few lines for a /review marker; the user sees a diff and must approve. */
export async function applyReviewFix(uriText: string, markedLine: number, message: string): Promise<void> {
  const parsed = parseReviewMessage(message);
  if (!parsed || !vscode.workspace.isTrusted || vscode.env?.remoteName) return;
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(uriText));
  const window = fixWindow(doc.lineCount, markedLine);
  const original = Array.from({length: window.end - window.start + 1}, (_, i) => doc.lineAt(window.start + i).text);
  const config = vscode.workspace.getConfiguration("aiPrivacyRouter");
  const client = new LocalOllama({
    model: configuredModel(config),
    endpoint: config.get<string>("ollamaEndpoint", "http://127.0.0.1:11434"),
    timeoutMs: config.get<number>("timeoutSeconds", 180) * 1000
  });
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
    void vscode.window.showErrorMessage("Hushavyr: local fix failed. Check Ollama. No cloud fallback.");
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
  const preview = await vscode.workspace.openTextDocument({content: full.join("\n"), language: doc.languageId});
  await vscode.commands.executeCommand("vscode.diff", doc.uri, preview.uri, "Hushavyr fix preview: " + parsed.title.slice(0, 60));
  const answer = await vscode.window.showInformationMessage("Apply the local fix? Nothing is saved until you save the file.", "Apply fix", "Discard");
  if (answer === "Apply fix") await vscode.workspace.applyEdit(edit);
}

export function registerApplyFix(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.commands.registerCommand("aiPrivacyRouter.applyReviewFix",
    (uri: string, line: number, message: string) => applyReviewFix(uri, line, message)));
  context.subscriptions.push(vscode.languages.registerCodeActionsProvider([{scheme: "file"}, {scheme: "untitled"}], {
    provideCodeActions(document, _range, ctx) {
      return ctx.diagnostics.filter(d => d.source === "Hushavyr" && parseReviewMessage(d.message)).map(d => {
        const action = new vscode.CodeAction("Hushavyr: propose a local fix", vscode.CodeActionKind.QuickFix);
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
        return document.uri.scheme === "file" && runnerFor(document.uri.fsPath) ? [action, prove, ...shared] : [action, ...shared];
      }).flat();
    }
  }, {providedCodeActionKinds: [vscode.CodeActionKind.QuickFix]}));
}
