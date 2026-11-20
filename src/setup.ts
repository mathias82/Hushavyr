import * as vscode from "vscode";
import {execFile} from "node:child_process";
import {totalmem} from "node:os";
import {LocalOllama} from "./ollama";
import {configuredModel, recommendedModel} from "./model";
export {recommendedModel};


/** Approximate resident size of common quantized models; warn before loading one that will swap. */
export function lowMemoryWarning(model: string, memoryBytes = totalmem()): string {
  const size = /(\d+(?:\.\d+)?)b\b/i.exec(model);
  if (!size) return "";
  const needGb = Number(size[1]) * 0.7 + 2;
  const haveGb = memoryBytes / 1024 ** 3;
  return needGb > haveGb ? "**Warning:** " + model + " needs about " + Math.ceil(needGb) + " GB of memory but this machine has " + Math.floor(haveGb) + " GB; expect slow responses. Run **Hushavyr: Setup** to pick a smaller model." : "";
}

export type Runner = (executable: string, args: string[]) => Promise<boolean>;
const defaultRunner: Runner = (executable, args) => new Promise(resolve =>
  execFile(executable, args, {timeout: 8000, windowsHide: true}, error => resolve(!error)));

/** Which optional offline tools are installed; each probe only runs `--version`. */
export async function detectTools(run: Runner = defaultRunner): Promise<Record<InstallableTool, boolean>> {
  const [semgrep, gitleaks, trivy] = await Promise.all([
    run("semgrep", ["--version"]), run("gitleaks", ["version"]), run("trivy", ["--version"])]);
  return {semgrep, gitleaks, trivy};
}

type InstallableTool = "semgrep" | "gitleaks" | "trivy";
const installPromptOpen = new Set<InstallableTool>();
const installCommands: Record<InstallableTool, {label: string; purpose: string; darwin: string; other: string}> = {
  semgrep: {label: "Semgrep", purpose: "additional offline security checks", darwin: "brew install semgrep", other: "pipx install semgrep"},
  gitleaks: {label: "Gitleaks", purpose: "offline secret scanning", darwin: "brew install gitleaks", other: "go install github.com/gitleaks/gitleaks/v8@latest"},
  trivy: {label: "Trivy", purpose: "offline dependency vulnerability audits", darwin: "brew install trivy && trivy image --download-db-only", other: "See https://trivy.dev/latest/getting-started/installation/ then run: trivy image --download-db-only"}
};
export async function offerToolInstallation(tool: InstallableTool): Promise<void> {
  if (installPromptOpen.has(tool)) return;
  installPromptOpen.add(tool);
  const info = installCommands[tool];
  try {
    const choice = await vscode.window.showInformationMessage(
      "Hushavyr: " + info.label + " is not installed. Install it locally to enable " + info.purpose + "?",
      "Show install command", "Not now"
    );
    if (choice !== "Show install command") return;
    if (process.platform === "win32") {
      await vscode.window.showInformationMessage(
        info.label + " should be installed through WSL or its official Windows installer, then Hushavyr run in that workspace. No command was executed.",
        { modal: true }, "OK"
      );
      return;
    }
    const command = process.platform === "darwin" ? info.darwin : info.other;
    const confirm = await vscode.window.showWarningMessage(
      "Run this command in a new terminal? " + command + ". This downloads software from the package manager; Hushavyr will not send project code.",
      { modal: true }, "Run install command", "Copy command"
    );
    if (confirm === "Copy command") {
      await vscode.env.clipboard.writeText(command);
    } else if (confirm === "Run install command") {
      const terminal = vscode.window.createTerminal({ name: "Hushavyr · Install " + info.label });
      terminal.show();
      terminal.sendText(command);
    }
  } finally {
    installPromptOpen.delete(tool);
  }
}

/** Guided first-run check: Ollama, model, optional scanners. Every install needs explicit consent. */
export async function runSetup(): Promise<void> {
  const config = vscode.workspace.getConfiguration("aiPrivacyRouter");
  const endpoint = config.get<string>("ollamaEndpoint", "http://127.0.0.1:11434");
  const timeoutMs = config.get<number>("timeoutSeconds", 180) * 1000;
  let model = configuredModel(config);
  const summary: string[] = [];
  const probe = new LocalOllama({model, endpoint, timeoutMs});
  if (!await probe.isRunning()) {
    const choice = await vscode.window.showWarningMessage(
      "Ollama is not running. Install or start it, then run Hushavyr: Setup again.", "Install Ollama", "Start Ollama");
    if (choice === "Install Ollama") await vscode.commands.executeCommand("aiPrivacyRouter.installOllama");
    if (choice === "Start Ollama") await vscode.commands.executeCommand("aiPrivacyRouter.startOllama");
    return;
  }
  summary.push("Ollama: running");
  const best = recommendedModel(totalmem());
  const options = [...new Set([model, best, "qwen2.5-coder:7b", "qwen2.5-coder:14b", "qwen2.5-coder:32b", "deepseek-coder-v2:16b"])];
  const pick = await vscode.window.showQuickPick(options.map(label => ({
    label, description: label === best ? "recommended for this machine's memory" : label === model ? "current" : undefined
  })), {placeHolder: "Choose the local review model (downloaded automatically if missing)"});
  if (!pick) return;
  if (pick.label !== model) {
    model = pick.label;
    await config.update("ollamaModel", model, vscode.ConfigurationTarget.Global);
  }
  try {
    await vscode.window.withProgress({location: vscode.ProgressLocation.Notification, title: "Hushavyr: preparing " + model, cancellable: true}, async (progress, token) => {
      const controller = new AbortController();
      token.onCancellationRequested(() => controller.abort());
      let last = 0;
      await new LocalOllama({model, endpoint, timeoutMs}).ensureInstalled(controller.signal, percent => {
        if (percent === undefined) return;
        progress.report({increment: Math.max(0, percent - last), message: percent + "%"});
        last = percent;
      });
    });
    summary.push("Model " + model + ": ready");
  } catch {
    void vscode.window.showErrorMessage("Hushavyr: could not prepare " + model + ". Check Ollama and disk space. No cloud fallback.");
    return;
  }
  const tools = await detectTools();
  for (const tool of Object.keys(tools) as InstallableTool[]) {
    summary.push(installCommands[tool].label + ": " + (tools[tool] ? "installed" : "not installed (optional)"));
  }
  void vscode.window.showInformationMessage("Hushavyr setup: " + summary.join(" · "));
  for (const tool of Object.keys(tools) as InstallableTool[]) if (!tools[tool]) await offerToolInstallation(tool);
}
