import * as vscode from "vscode";
import {configuredClient, configuredModel} from "./model/model";
import {join, sep} from "node:path";
import {FixProofReceipt, bugReproduced, runFixProof} from "./fixProof";
import {FixSandbox} from "./fixSandbox";

import {testSchema, fixSchema, parseTestProposal, parseFixProposal} from "./fixProposals";
import {projectRootFor, ProofRunner, runnerFor} from "./proofTarget";
import {proofFixPrompt, proofProfile, proofTestPrompt} from "./proofPrompts";

/** A /review finding to prove: its file and the marker text, which becomes the bug description. */
export interface ProofRequest {file: string; message: string}

async function approve(title: string, content: string, token: vscode.CancellationToken): Promise<boolean> {
  if (token.isCancellationRequested) return false;
  const panel = vscode.window.createWebviewPanel("aiPrivacy.localFix", title, vscode.ViewColumn.Active,
    {enableScripts: false, enableCommandUris: false, localResourceRoots: []});
  const escaped = content.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  panel.webview.html = "<!doctype html><html><head><meta charset=\"utf-8\">" +
    "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'\">" +
    "<style>body{font-family:monospace;padding:24px}pre{white-space:pre-wrap;word-break:break-word}</style>" +
    "</head><body><h2>Local snapshot proposal</h2><p>Review all code. Only the private snapshot changes. " +
    "Generated code will execute only in the offline container; it never runs directly on the host.</p><pre>" +
    escaped + "</pre></body></html>";
  return new Promise(resolve => {
    let finished = false;
    const finish = (accepted: boolean): void => {
      if (finished) return; finished = true;
      cancellation.dispose(); closed.dispose(); panel.dispose();
      resolve(accepted && !token.isCancellationRequested);
    };
    const cancellation = token.onCancellationRequested(() => finish(false));
    const closed = panel.onDidDispose(() => finish(false));
    if (token.isCancellationRequested) {finish(false); return;}
    void vscode.window.showWarningMessage(title + ": inspect the complete preview before continuing.",
      {modal: false}, "Approve snapshot change").then(
        answer => finish(answer === "Approve snapshot change"), () => finish(false));
  });
}
export function registerVerifiedFix(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.commands.registerCommand("aiPrivacyRouter.verifyLocalFix", async (finding?: ProofRequest) => {
    const localProfile = (): boolean => vscode.workspace.isTrusted === true &&
      vscode.workspace.getConfiguration("chat").get<boolean>("disableAIFeatures", false) === true;
    if (!localProfile()) {
      void vscode.window.showWarningMessage("Use a trusted local-only profile with chat.disableAIFeatures enabled. This command never uses Copilot.");
      return;
    }
    // From a /review marker the runner, project, file and bug description are already known.
    const findingFile = finding ? vscode.Uri.parse(finding.file) : undefined;
    const workspaceRoot = findingFile && vscode.workspace.getWorkspaceFolder(findingFile)?.uri.fsPath;
    const knownRunner = findingFile?.scheme === "file" ? runnerFor(findingFile.fsPath) : undefined;
    const knownRoot = knownRunner && workspaceRoot ? projectRootFor(findingFile!.fsPath, knownRunner, workspaceRoot) : undefined;
    const runner = knownRoot ? knownRunner : await vscode.window.showQuickPick(["Java / Maven", "Python / pytest", "JavaScript / Node.js", "TypeScript / Node.js", "Go / go test"],
      {placeHolder: "Choose an offline test runner"});
    if (!runner) return;
    const go = runner === "Go / go test";
    const python = runner === "Python / pytest";
    const typescript = runner === "TypeScript / Node.js";
    const node = runner === "JavaScript / Node.js" || typescript;
    const language = go ? "Go" : typescript ? "TypeScript" : node ? "JavaScript" : python ? "Python" : "Java";
    const folder = knownRoot ? [vscode.Uri.file(knownRoot)] : await vscode.window.showOpenDialog({canSelectFolders: true, canSelectFiles: false,
      canSelectMany: false, openLabel: go ? "Choose a Go module (folder with go.mod)" : node ? "Choose a project with Node.js native tests" : python ? "Choose a Python project with a tests folder" : "Choose a leaf Maven project",
      defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri});
    const project = folder?.[0];
    if (!project || project.scheme !== "file") return;
    if (vscode.workspace.textDocuments.some(d => d.isDirty && d.uri.scheme === "file" &&
      d.uri.fsPath.startsWith(project.fsPath + sep))) {
      void vscode.window.showWarningMessage("Save and commit project edits before verifying a committed snapshot."); return;
    }
    const selected = knownRoot ? [findingFile!] : await vscode.window.showOpenDialog({canSelectMany: true, canSelectFiles: true, canSelectFolders: false,
      defaultUri: python || node || go ? project : vscode.Uri.joinPath(project, "src", "main", "java"),
      filters: {[language]: go ? ["go"] : typescript ? ["ts", "cts", "mts"] : node ? ["js", "cjs", "mjs"] : [python ? "py" : "java"]},
      openLabel: "Choose 1–6 production " + language + " files for local analysis"});
    if (!selected?.length || selected.some(uri => uri.scheme !== "file")) return;
    const goal = await vscode.window.showInputBox({prompt: "Describe one observable bug and the expected behavior (local Ollama only)", ignoreFocusOut: true,
      value: finding?.message.replace(/\s+/g, " ").slice(0, 1400)});
    if (!goal?.trim()) return;
    if (Buffer.byteLength(goal, "utf8") > 1500) {
      void vscode.window.showWarningMessage("Keep the bug description within 1.5 KB."); return;
    }
    try {
      const result = await vscode.window.withProgress({location: vscode.ProgressLocation.Notification,
        title: "Local regression proof", cancellable: true}, async (progress, token) => {
        const controller = new AbortController();
        const cancellation = token.onCancellationRequested(() => controller.abort());
        const policyChange = vscode.workspace.onDidChangeConfiguration(() => {if (!localProfile()) controller.abort();});
        const cancelled = (): boolean => token.isCancellationRequested || controller.signal.aborted || !localProfile();
        let sandbox: FixSandbox | undefined;
        try {
          if (cancelled()) return;
          progress.report({message: "Preparing committed snapshot and local offline container"});
          const config = vscode.workspace.getConfiguration("aiPrivacyRouter");
          sandbox = await FixSandbox.create({project: project.fsPath, selected: selected.map(uri => uri.fsPath),
            storage: join(context.globalStorageUri.fsPath, "verified-fixes"),
            profile: go ? "go" : typescript ? "typescript" : node ? "node" : python ? "python" : undefined,
            image: go ? config.get<string>("fixGoImage", "golang:1.24") : typescript ? config.get<string>("fixTypeScriptImage", "hushavyr-typescript:local") : node ? config.get<string>("fixNodeImage", "node:24-slim") : python ? config.get<string>("fixPythonImage", "hushavyr-pytest:local")
              : config.get<string>("fixMavenImage", "maven:3.9-eclipse-temurin-21"),
            cache: config.get<string>("fixMavenCache", "").trim() || undefined, goModCache: config.get<string>("fixGoModCache", "").trim() || undefined,
            signal: controller.signal});
          const box = sandbox;
          const client = configuredClient(config);
          const input = JSON.stringify({goal, sources: box.sources});
          const profile = proofProfile(runner as ProofRunner);
          const receipt = await runFixProof({...box.context, localModel: configuredModel(config)}, {
            cancelled,
            run: async (stage, target) => {progress.report({message: "Running " + stage + " tests in offline Docker"}); return box.run(stage, target);},
            proposeTest: async () => {
              progress.report({message: "Generating one local regression test"});
              await client.ensureAvailable(controller.signal);
              return parseTestProposal(await client.generate(proofTestPrompt(profile, box.context, input), {schema: testSchema, signal: controller.signal}));
            },
            approveTest: source => approve("Approve generated regression test", source, token),
            writeTest: source => box.writeTest(source),
            proposeFix: async testSource => {
              progress.report({message: "Generating one local production fix"});
              return parseFixProposal(await client.generate(proofFixPrompt(profile, testSource, input), {schema: fixSchema, signal: controller.signal}));
            },
            approveFix: changes => approve("Approve production changes in snapshot", JSON.stringify(changes, null, 2), token),
            applyFix: changes => box.applyFix(changes)
          });
          const directory = await box.save(receipt);
          return {receipt, directory};
        } finally {
          cancellation.dispose(); policyChange.dispose();
          if (sandbox) await sandbox.dispose();
        }
      });
      if (!result) return;
      const receipt: FixProofReceipt = result.receipt;
      const message = "Local regression proof: " + receipt.status + " (" + receipt.reason + "). Artifacts: " + result.directory +
        ". The active checkout was not changed.";
      if (receipt.status !== "verified" && bugReproduced(receipt)) void vscode.window.showWarningMessage("Bug confirmed: an approved test fails on the unchanged code. " + message);
      else if (receipt.status === "verified") void vscode.window.showInformationMessage(message +
        " verified.patch is bound to base " + receipt.baseCommit + ". Review it before applying; this is not a proof of all behavior.", "Create draft PR").then(choice => {
        if (choice === "Create draft PR") void vscode.commands.executeCommand("aiPrivacyRouter.createVerifiedFixPr", result.directory);
      });
      else void vscode.window.showWarningMessage(message);
    } catch {
      void vscode.window.showErrorMessage("Local verification stopped. Check: clean committed sources, the selected project layout, non-root macOS/Linux, local Docker and a preloaded runner image. Maven needs a populated dependency cache; Go modules need vendor/ or the local module cache. No cloud fallback or active-checkout patch was attempted.");
    }
  }));
}
