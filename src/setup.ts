import * as vscode from "vscode";
import {execFile} from "node:child_process";
import {existsSync} from "node:fs";
import {homedir, totalmem} from "node:os";
import {defaultFindSecBugsPlugin, hasOsvDatabase} from "./codeScanners";
import {LocalOllama} from "./ollama";
import {hasInstaller, ollamaInstaller, runs, startOllamaServer} from "./ollamaCommands";
import {tr} from "./i18n";
import {configuredModel, isLocalModelName, modelChoices, recommendedModel} from "./model";
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

/** Which optional offline tools are installed; each probe only runs `--version`. FindSecBugs also needs its plugin jar. */
export async function detectTools(run: Runner = defaultRunner, findSecBugsPlugin = defaultFindSecBugsPlugin(), exists: (path: string) => boolean = existsSync): Promise<Record<InstallableTool, boolean>> {
  const [semgrep, gitleaks, trivy, spotbugs, bandit, gosec, osv] = await Promise.all([
    run("semgrep", ["--version"]), run("gitleaks", ["version"]), run("trivy", ["--version"]), run("spotbugs", ["-version"]),
    run("bandit", ["--version"]), run("gosec", ["-version"]), run("osv-scanner", ["--version"])]);
  return {semgrep, gitleaks, trivy, findsecbugs: spotbugs && exists(findSecBugsPlugin), bandit, gosec, "osv-scanner": osv};
}

export type InstallableTool = "semgrep" | "gitleaks" | "trivy" | "findsecbugs" | "bandit" | "gosec" | "osv-scanner";
/** Only offer analyzers the workspace can use: Bandit for Python, gosec for Go modules, FindSecBugs for Maven/Gradle builds. */
export function relevantTools(installed: Record<InstallableTool, boolean>, has: {python: boolean; go: boolean; jvm: boolean}): InstallableTool[] {
  const relevant: Record<InstallableTool, boolean> = {semgrep: true, gitleaks: true, trivy: true, "osv-scanner": true, bandit: has.python, gosec: has.go, findsecbugs: has.jvm};
  return (Object.keys(installed) as InstallableTool[]).filter(tool => !installed[tool] && relevant[tool]);
}
const pluginUrl = "https://repo1.maven.org/maven2/com/h3xstream/findsecbugs/findsecbugs-plugin/1.14.0/findsecbugs-plugin-1.14.0.jar";
const pluginDownload = "mkdir -p ~/.hushavyr && curl -fsSL -o ~/.hushavyr/findsecbugs-plugin.jar " + pluginUrl;
/** Downloads public OSV.dev data for the ecosystems found in `root`; vulnerability matching itself stays local. */
export const osvDatabaseCommand = (root: string): string =>
  "osv-scanner scan source --offline-vulnerabilities --download-offline-databases --no-resolve --format table -r '" + root.replace(/'/g, "'\\''") + "'";
const installPromptOpen = new Set<InstallableTool>();
const installCommands: Record<InstallableTool, {label: string; purpose: string; darwin: string; other: string}> = {
  semgrep: {label: "Semgrep", purpose: "additional offline security checks", darwin: "brew install semgrep", other: "pipx install semgrep"},
  gitleaks: {label: "Gitleaks", purpose: "offline secret scanning", darwin: "brew install gitleaks", other: "go install github.com/gitleaks/gitleaks/v8@latest"},
  trivy: {label: "Trivy", purpose: "offline dependency vulnerability audits", darwin: "brew install trivy && trivy image --download-db-only", other: "See https://trivy.dev/latest/getting-started/installation/ then run: trivy image --download-db-only"},
  findsecbugs: {label: "FindSecBugs (SpotBugs)", purpose: "bytecode security analysis of compiled Java and Kotlin classes", darwin: "brew install spotbugs && " + pluginDownload, other: "See https://spotbugs.readthedocs.io/en/latest/installing.html then run: " + pluginDownload},
  bandit: {label: "Bandit", purpose: "offline Python security checks", darwin: "brew install bandit", other: "pipx install bandit"},
  gosec: {label: "gosec", purpose: "offline Go security checks", darwin: "brew install gosec", other: "go install github.com/securego/gosec/v2/cmd/gosec@latest"},
  "osv-scanner": {label: "OSV-Scanner", purpose: "offline dependency vulnerability checks against the OSV.dev database", darwin: "brew install osv-scanner", other: "go install github.com/google/osv-scanner/v2/cmd/osv-scanner@latest"}
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
      if (tool === "osv-scanner") await offerOsvDatabase(terminal);
    }
  } finally {
    installPromptOpen.delete(tool);
  }
}

/** OSV-Scanner only scans offline in Hushavyr, so it needs a local database; downloading one is a separate, explicit choice. */
export async function offerOsvDatabase(terminal?: vscode.Terminal): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root || process.platform === "win32") return;
  const choice = await vscode.window.showInformationMessage(
    "Hushavyr: download the OSV offline vulnerability database for this workspace? It fetches public OSV.dev data for the package ecosystems used here (npm, Maven, PyPI, ...). No code or dependency list is sent; later scans run fully offline.",
    {modal: true}, "Download database", "Not now");
  if (choice !== "Download database") return;
  const target = terminal ?? vscode.window.createTerminal({name: "Hushavyr · OSV database"});
  target.show();
  target.sendText(osvDatabaseCommand(root));
}

/** What this machine has, and what the user chose, before setup runs. */
export interface SetupState {
  platform: NodeJS.Platform; root?: string;
  ollama: boolean; installer?: string; running: boolean;
  model: string; modelReady: boolean;
  tools: InstallableTool[]; osvInstalled: boolean; osvDatabase: boolean;
}
export interface SetupStep { kind: "ollama-install" | "ollama-start" | "model" | "tool" | "osv-database"; label: string; command: string; tool?: InstallableTool }

/** The steps that bring this machine to a working setup, in order: Ollama, its server, the model, then the chosen analyzers. */
export function setupPlan(state: SetupState): SetupStep[] {
  const steps: SetupStep[] = [];
  if (!state.ollama && state.installer) steps.push({kind: "ollama-install", label: "Install Ollama", command: state.installer});
  if (!state.running) steps.push({kind: "ollama-start", label: "Start the local Ollama server (127.0.0.1 only)", command: "ollama serve"});
  if (!state.modelReady) steps.push({kind: "model", label: "Download the model " + state.model + " (several GB, once)", command: "ollama pull " + state.model});
  if (state.platform === "win32") return steps;
  for (const tool of state.tools)
    steps.push({kind: "tool", tool, label: "Install " + installCommands[tool].label + " (" + installCommands[tool].purpose + ")", command: state.platform === "darwin" ? installCommands[tool].darwin : installCommands[tool].other});
  if (state.root && !state.osvDatabase && (state.osvInstalled || state.tools.includes("osv-scanner")))
    steps.push({kind: "osv-database", label: "Download the OSV offline vulnerability database (public data, no code sent)", command: osvDatabaseCommand(state.root)});
  return steps;
}

/** Runs a shell command as a visible VS Code task and resolves with its exit code (undefined when it could not start). */
async function runTask(name: string, command: string): Promise<number | undefined> {
  const task = new vscode.Task({type: "shell"}, vscode.workspace.workspaceFolders?.[0] ?? vscode.TaskScope.Workspace, name, "Hushavyr",
    new vscode.ShellExecution(command, {cwd: homedir()}));
  task.presentationOptions = {reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Shared, clear: false};
  const ended = new Map<vscode.TaskExecution, number | undefined>();
  let waiting: ((code: number | undefined) => void) | undefined, execution: vscode.TaskExecution | undefined;
  const listener = vscode.tasks.onDidEndTaskProcess(event => {
    if (event.execution === execution && waiting) waiting(event.exitCode); else ended.set(event.execution, event.exitCode);
  });
  try {
    execution = await vscode.tasks.executeTask(task);
    if (ended.has(execution)) return ended.get(execution);
    return await new Promise<number | undefined>(resolve => { waiting = resolve; });
  } catch {
    return undefined;
  } finally {
    listener.dispose();
  }
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** One-click setup: installs and starts Ollama, downloads the model and installs every missing dependency and security analyzer (with the Trivy and OSV databases), after a single confirmation listing every command. */
export async function runSetup(): Promise<void> {
  if (!vscode.workspace.isTrusted || vscode.env?.remoteName) {
    await vscode.window.showInformationMessage("Open a trusted local VS Code window to set up Hushavyr.");
    return;
  }
  const config = vscode.workspace.getConfiguration("aiPrivacyRouter");
  const endpoint = config.get<string>("ollamaEndpoint", "http://127.0.0.1:11434");
  const timeoutMs = config.get<number>("timeoutSeconds", 180) * 1000;
  const language = config.get<string>("language", "en");
  const platform = process.platform, root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const probe = new LocalOllama({model: configuredModel(config), endpoint, timeoutMs});
  const exclude = "**/{node_modules,.git,.venv,venv,vendor}/**";
  const [running, ollama, installer, tools, osvDatabase, python, go, jvm] = await Promise.all([
    probe.isRunning(), runs("ollama", ["--version"]),
    (async () => { const found = ollamaInstaller(platform); return found && await hasInstaller(found) ? found.command : undefined; })(),
    detectTools(undefined, config.get<string>("findSecBugsPlugin", "") || defaultFindSecBugsPlugin()), hasOsvDatabase(),
    ...["**/*.py", "**/go.mod", "**/{pom.xml,build.gradle,build.gradle.kts}"].map(async glob => (await vscode.workspace.findFiles(glob, exclude, 1)).length > 0)]);
  if (!ollama && !running && !installer) {
    const download = ollamaInstaller(platform)?.download ?? "https://ollama.com/download";
    const action = await vscode.window.showWarningMessage("Hushavyr: Ollama is not installed and no installer (Homebrew, WinGet, curl) was found. Install Ollama, then run Hushavyr: Setup again.", "Download Ollama");
    if (action) await vscode.env.openExternal(vscode.Uri.parse(download));
    return;
  }

  // Choices first, so the confirmation lists everything that will run.
  const installed = running ? await probe.listModels().catch(() => [] as string[]) : [];
  let model = configuredModel(config);
  const best = recommendedModel(totalmem());
  const tagText = (tag: string) => tag === "recommended" ? tr(language, "setupRecommended") : tag === "current" ? tr(language, "setupCurrent") : tag;
  const other = "$(edit) Other…";
  const pick = await vscode.window.showQuickPick([...modelChoices(model, best, installed).map(choice => ({label: choice.label, description: choice.tags.map(tagText).join(" · ") || undefined})),
    {label: other, description: "any Ollama model name, e.g. codestral"}], {placeHolder: tr(language, "setupPick")});
  if (!pick) return;
  const chosen = pick.label === other ? (await vscode.window.showInputBox({prompt: "Ollama model name (downloaded locally if missing)", placeHolder: "codestral:22b",
    validateInput: value => isLocalModelName(value.trim()) ? undefined : "Enter a local Ollama model name such as codestral or qwen2.5-coder:14b"}))?.trim() : pick.label;
  if (!chosen) return;
  if (chosen !== model) {
    model = chosen;
    await config.update("ollamaModel", model, vscode.ConfigurationTarget.Global);
  }
  // Every missing dependency and security analyzer; the ones this workspace's languages use are listed first.
  const relevant = new Set(relevantTools(tools, {python, go, jvm}));
  const missing = platform === "win32" ? [] : (Object.keys(tools) as InstallableTool[]).filter(tool => !tools[tool]).sort((a, b) => Number(relevant.has(b)) - Number(relevant.has(a)));
  let chosenTools: InstallableTool[] = [];
  if (missing.length) {
    const picked = await vscode.window.showQuickPick(missing.map(tool => ({label: installCommands[tool].label, description: installCommands[tool].purpose, picked: true, tool})),
      {canPickMany: true, placeHolder: "Dependency and security analyzers to install (uncheck any you do not want)"});
    if (!picked) return;
    chosenTools = picked.map(item => item.tool);
  }

  const steps = setupPlan({platform, root, ollama, installer, running, model, modelReady: installed.includes(model), tools: chosenTools, osvInstalled: tools["osv-scanner"], osvDatabase});
  const summary = () => "Ollama: " + (ollama || steps.some(s => s.kind === "ollama-install") ? "installed" : "missing") + " · model " + model +
    " · analyzers: " + (Object.keys(tools) as InstallableTool[]).filter(tool => tools[tool] || chosenTools.includes(tool)).map(tool => installCommands[tool].label).join(", ");
  if (!steps.length) {
    void vscode.window.showInformationMessage(tr(language, "setupDone") + " " + summary());
    return;
  }
  const confirm = await vscode.window.showInformationMessage("Hushavyr Setup will run " + steps.length + " step(s) on this machine", {modal: true,
    detail: steps.map((step, i) => (i + 1) + ". " + step.label + "\n    " + step.command).join("\n") + "\n\nDownloads come from the package managers and ollama.com; no project code is sent."}, "Run setup");
  if (confirm !== "Run setup") return;

  const failed: string[] = [];
  await vscode.window.withProgress({location: vscode.ProgressLocation.Notification, title: "Hushavyr setup", cancellable: true}, async (progress, token) => {
    const controller = new AbortController();
    token.onCancellationRequested(() => controller.abort());
    for (const [i, step] of steps.entries()) {
      if (token.isCancellationRequested) { failed.push("cancelled"); return; }
      progress.report({message: (i + 1) + "/" + steps.length + ": " + step.label});
      if (step.kind === "ollama-start") {
        startOllamaServer();
        let up = false;
        for (let t = 0; t < 30 && !up && !token.isCancellationRequested; t++) { await wait(1000); up = await probe.isRunning(); }
        if (!up) { failed.push("the Ollama server did not start (see the Hushavyr: Ollama server terminal)"); return; }
      } else if (step.kind === "model") {
        let last = 0;
        try {
          await new LocalOllama({model, endpoint, timeoutMs}).ensureInstalled(controller.signal, percent => {
            if (percent === undefined || percent === last) return;
            progress.report({message: (i + 1) + "/" + steps.length + ": " + step.label + " " + percent + "%"});
            last = percent;
          });
        } catch {
          failed.push(model + " " + tr(language, "setupFailed"));
          return;
        }
      } else {
        const code = await runTask("Hushavyr setup: " + step.label, step.command);
        if (code !== 0) {
          failed.push(step.label + " (exit code " + (code ?? "unknown") + ")");
          // Nothing else works without Ollama; analyzers are independent of each other.
          if (step.kind === "ollama-install") return;
        }
      }
    }
  });
  if (failed.length) void vscode.window.showWarningMessage("Hushavyr setup did not finish: " + failed.join("; ") + ". Fix it and run Hushavyr: Setup again; finished steps are skipped.");
  else void vscode.window.showInformationMessage(tr(language, "setupDone") + " " + summary());
}
