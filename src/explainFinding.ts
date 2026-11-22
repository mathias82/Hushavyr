// "Explain finding": the deterministic scanner result stays as reported; local Ollama only explains it in context and suggests a fix.
import * as vscode from "vscode";
import {explainFindingPrompt, findingsFromReport, previewLinks, ReportFinding} from "./reportFindings";
import {configuredClient} from "./model";
import {classifyInput} from "./classifier";

export const EXPLAIN_FINDING = "aiPrivacyRouter.explainFinding";
export interface FindingArg { uri: string; line: number; message: string }
let lastFindings: ReportFinding[] = [];

/** Keeps the findings of the latest security/dependency/secrets report for the "Explain finding" picker. */
export function rememberReport(markdown: string): number {
  lastFindings = findingsFromReport(markdown);
  return lastFindings.length;
}

export function forgetFinding(uri: string, line: number): void {
  lastFindings = lastFindings.filter(f => f.uri !== uri || f.line !== line);
}

export function registerExplainFinding(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(EXPLAIN_FINDING, async (arg?: FindingArg) => {
      const finding = arg ?? await pickFinding();
      if (finding) await explain(context, finding);
    }),
    vscode.languages.registerCodeActionsProvider({scheme: "file"}, {
      provideCodeActions: (document, _range, codeContext) => codeContext.diagnostics.filter(d => d.source === "Hushavyr").map(d => {
        const name = d.message.split("\n")[0].replace(/^(critical|high|medium|low|potential)\s*[·:]\s*/i, "").split(" · ")[0].slice(0, 60);
        const action = new vscode.CodeAction("Hushavyr: Explain \u201c" + name + "\u201d (local AI)", vscode.CodeActionKind.QuickFix);
        action.command = {command: EXPLAIN_FINDING, title: action.title,
          arguments: [{uri: document.uri.toString(), line: d.range.start.line + 1, message: d.message} satisfies FindingArg]};
        action.diagnostics = [d];
        return action;
      })
    }, {providedCodeActionKinds: [vscode.CodeActionKind.QuickFix]}));
}

export async function pickFinding(placeHolder = "Which finding should local AI explain?", accept: (finding: FindingArg) => boolean = () => true): Promise<FindingArg | undefined> {
  const editor = vscode.window.activeTextEditor;
  const here = editor ? vscode.languages.getDiagnostics(editor.document.uri)
    .filter(d => d.source === "Hushavyr" && d.range.start.line === editor.selection.active.line) : [];
  const items = [
    ...here.map(d => ({label: d.message.split("\n")[0], description: vscode.workspace.asRelativePath(editor!.document.uri, false) + ":" + (d.range.start.line + 1),
      finding: {uri: editor!.document.uri.toString(), line: d.range.start.line + 1, message: d.message}})),
    ...lastFindings.map(f => ({label: f.message, description: vscode.workspace.asRelativePath(vscode.Uri.parse(f.uri), false) + ":" + f.line, finding: f as FindingArg}))
  ].filter(item => accept(item.finding));
  if (!items.length) {
    void vscode.window.showInformationMessage("Hushavyr: run Security Scan, Find Hardcoded Secrets or Check Dependencies first, then pick a finding.");
    return;
  }
  if (items.length === 1) return items[0].finding;
  return (await vscode.window.showQuickPick(items, {placeHolder, matchOnDescription: true}))?.finding;
}

async function explain(context: vscode.ExtensionContext, finding: FindingArg): Promise<void> {
  const uri = vscode.Uri.parse(finding.uri);
  let document: vscode.TextDocument;
  try { document = await vscode.workspace.openTextDocument(uri); }
  catch { void vscode.window.showWarningMessage("Hushavyr: the file of this finding could not be opened."); return; }
  const path = vscode.workspace.asRelativePath(uri, false);
  const prompt = explainFindingPrompt({message: finding.message, path, line: finding.line}, document.getText().split(/\r?\n/), document.languageId);
  if (classifyInput({prompt, workspaceTrusted: vscode.workspace.isTrusted}).route === "blocked") {
    void vscode.window.showErrorMessage("Content blocked by privacy policy. Nothing was sent.");
    return;
  }
  const folder = vscode.Uri.joinPath(context.globalStorageUri, "reports");
  await vscode.workspace.fs.createDirectory(folder);
  const report = vscode.Uri.joinPath(folder, "explain-finding.md");
  const link = "[" + path + ":" + finding.line + "](" + uri.with({fragment: "L" + finding.line}).toString() + ")";
  let text = "# Hushavyr · Explain finding\n\n**Scanner finding (unchanged):** " + finding.message.replace(/\r?\n/g, " ") + " · " + link +
    "\n\n## Local AI explanation\n\n_Local model, nothing leaves this machine. Verify before applying._\n\n";
  const write = () => vscode.workspace.fs.writeFile(report, Buffer.from(previewLinks(text, folder.fsPath), "utf8"));
  await write();
  await vscode.commands.executeCommand("markdown.showPreviewToSide", report);
  let lastWrite = Date.now();
  try {
    await vscode.window.withProgress({location: vscode.ProgressLocation.Notification, title: "Hushavyr: explaining finding with local AI", cancellable: true}, async (_, token) => {
      const controller = new AbortController();
      const subscription = token.onCancellationRequested(() => controller.abort());
      try {
        const client = configuredClient(vscode.workspace.getConfiguration("aiPrivacyRouter"));
        await client.ensureAvailable(controller.signal);
        await client.generate(prompt, {signal: controller.signal, onText: chunk => {
          text += chunk;
          if (Date.now() - lastWrite > 700) { lastWrite = Date.now(); void write(); }
        }});
      } finally { subscription.dispose(); }
    });
  } catch {
    text += "\n\nLocal Ollama failed or was cancelled. No cloud fallback or external transfer was attempted. Run **Hushavyr: Setup** if Ollama is not running.\n";
  }
  await write();
}
