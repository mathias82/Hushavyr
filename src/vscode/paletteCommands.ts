// Command Palette versions of the main chat commands, for editors without VS Code Chat (or with Chat turned off).
// They run the same handler as @ai-privacy; the answer opens as a Markdown preview and findings go to the Problems panel.
import * as vscode from "vscode";
import {findingsFromReport, previewLinks} from "./reportFindings";
import {EXPLAIN_FINDING} from "./explainFinding";

export const PALETTE_COMMANDS: readonly {id: string; command: string; title: string; prompt?: string}[] = [
  {id: "aiPrivacyRouter.reviewFile", command: "review", title: "Review"},
  {id: "aiPrivacyRouter.explainFile", command: "explain", title: "Explanation"},
  {id: "aiPrivacyRouter.reviewChanges", command: "review-changes", title: "Review of uncommitted changes"},
  {id: "aiPrivacyRouter.scanProject", command: "scan", title: "Project scan"},
  {id: "aiPrivacyRouter.scanChanged", command: "scan-changed", title: "Scan of changed files"},
  {id: "aiPrivacyRouter.securityScan", command: "security", title: "Security scan"},
  {id: "aiPrivacyRouter.findSecrets", command: "secrets", title: "Secrets scan"},
  {id: "aiPrivacyRouter.checkDependencies", command: "dependencies", title: "Dependency audit"},
  {id: "aiPrivacyRouter.secretsHistory", command: "gitleaks", title: "Secrets in git history", prompt: "history"}
];

// /review and /review-changes already publish their own markers; the rest are read back from the report links.
const PUBLISHES_ITS_OWN = new Set(["review", "review-changes", "explain"]);
const LEVEL = {high: vscode.DiagnosticSeverity.Error, medium: vscode.DiagnosticSeverity.Warning, low: vscode.DiagnosticSeverity.Information};

let scanCollection: vscode.DiagnosticCollection | undefined;
export function clearScanFindings(): void { scanCollection?.clear(); }
export function dropScanFinding(uri: vscode.Uri, line: number): void {
  const list = scanCollection?.get(uri);
  if (list) scanCollection!.set(uri, list.filter(d => d.range.start.line !== line));
}

export function registerPaletteCommands(context: vscode.ExtensionContext, handler: vscode.ChatRequestHandler): void {
  const scanDiagnostics = scanCollection = vscode.languages.createDiagnosticCollection("hushavyr-scan");
  context.subscriptions.push(scanDiagnostics);
  for (const entry of PALETTE_COMMANDS)
    context.subscriptions.push(vscode.commands.registerCommand(entry.id, () => run(context, handler, scanDiagnostics, entry.command, entry.title, entry.prompt)));
}

async function run(context: vscode.ExtensionContext, handler: vscode.ChatRequestHandler, scanDiagnostics: vscode.DiagnosticCollection,
  command: string, title: string, prompt = ""): Promise<void> {
  const folder = vscode.Uri.joinPath(context.globalStorageUri, "reports");
  await vscode.workspace.fs.createDirectory(folder);
  const report = vscode.Uri.joinPath(folder, command + (prompt ? "-" + prompt : "") + ".md");
  let text = "# Hushavyr · " + title + "\n\n";
  const write = () => vscode.workspace.fs.writeFile(report, Buffer.from(previewLinks(text, folder.fsPath), "utf8"));
  await write();
  await vscode.commands.executeCommand("markdown.showPreviewToSide", report);
  let lastWrite = Date.now();
  await vscode.window.withProgress({location: vscode.ProgressLocation.Notification, title: "Hushavyr: " + title, cancellable: true}, async (progress, cancel) => {
    const stream = {
      markdown: (value: string | vscode.MarkdownString) => {
        text += typeof value === "string" ? value : value.value;
        if (Date.now() - lastWrite > 1000) { lastWrite = Date.now(); void write(); }
      },
      progress: (message: string) => progress.report({message}),
      button: () => undefined, anchor: () => undefined, reference: () => undefined, filetree: () => undefined, push: () => undefined
    } as unknown as vscode.ChatResponseStream;
    const request = {command, prompt, references: [], toolReferences: []} as unknown as vscode.ChatRequest;
    await handler(request, {history: []} as unknown as vscode.ChatContext, stream, cancel);
  });
  await write();
  if (PUBLISHES_ITS_OWN.has(command)) return;
  scanDiagnostics.clear();
  const byUri = new Map<string, vscode.Diagnostic[]>();
  for (const f of findingsFromReport(text)) {
    const line = Math.max(0, f.line - 1);
    const diagnostic = new vscode.Diagnostic(new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER), f.message, LEVEL[f.severity]);
    diagnostic.source = "Hushavyr";
    byUri.set(f.uri, [...(byUri.get(f.uri) ?? []), diagnostic]);
  }
  for (const [uri, list] of byUri) scanDiagnostics.set(vscode.Uri.parse(uri), list);
  const count = [...byUri.values()].reduce((n, list) => n + list.length, 0);
  if (count) void vscode.window.showInformationMessage("Hushavyr: " + count + " finding(s) added to the Problems panel.", "Open Problems", "Explain a Finding (Local AI)", "Fix or Dismiss a Finding")
    .then(choice => {
      if (choice === "Open Problems") void vscode.commands.executeCommand("workbench.actions.view.problems");
      else if (choice === "Fix or Dismiss a Finding") void vscode.commands.executeCommand("aiPrivacyRouter.fixFinding");
      else if (choice) void vscode.commands.executeCommand(EXPLAIN_FINDING);
    });
}
