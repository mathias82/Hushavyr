/** Setup steps shared by the VS Code Setup command and the hushavyr terminal: what is installed, and what to run. No VS Code API. */
import {execFile} from "node:child_process";
import {existsSync} from "node:fs";
import {homedir} from "node:os";
import {defaultFindSecBugsPlugin} from "./codeScanners";

/** Ollama server environment: flash attention and an 8-bit KV cache roughly halve context memory with no visible quality loss. */
export const OLLAMA_SERVE_ENV = {OLLAMA_FLASH_ATTENTION: "1", OLLAMA_KV_CACHE_TYPE: "q8_0"};

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
export const installCommands: Record<InstallableTool, {label: string; purpose: string; darwin: string; other: string}> = {
  semgrep: {label: "Semgrep", purpose: "additional offline security checks", darwin: "brew install semgrep", other: "pipx install semgrep"},
  gitleaks: {label: "Gitleaks", purpose: "offline secret scanning", darwin: "brew install gitleaks", other: "go install github.com/gitleaks/gitleaks/v8@latest"},
  trivy: {label: "Trivy", purpose: "offline dependency vulnerability audits", darwin: "brew install trivy && trivy image --download-db-only", other: "See https://trivy.dev/latest/getting-started/installation/ then run: trivy image --download-db-only"},
  findsecbugs: {label: "FindSecBugs (SpotBugs)", purpose: "bytecode security analysis of compiled Java and Kotlin classes", darwin: "brew install spotbugs && " + pluginDownload, other: "See https://spotbugs.readthedocs.io/en/latest/installing.html then run: " + pluginDownload},
  bandit: {label: "Bandit", purpose: "offline Python security checks", darwin: "brew install bandit", other: "pipx install bandit"},
  gosec: {label: "gosec", purpose: "offline Go security checks", darwin: "brew install gosec", other: "go install github.com/securego/gosec/v2/cmd/gosec@latest"},
  "osv-scanner": {label: "OSV-Scanner", purpose: "offline dependency vulnerability checks against the OSV.dev database", darwin: "brew install osv-scanner", other: "go install github.com/google/osv-scanner/v2/cmd/osv-scanner@latest"}
};
/** Package managers the analyzer installs can use. */
export interface Installers { brew: boolean; pipx: boolean; go: boolean }
export async function detectInstallers(run: Runner = defaultRunner): Promise<Installers> {
  const [brew, pipx, go] = await Promise.all([run("brew", ["--version"]), run("pipx", ["--version"]), run("go", ["version"])]);
  return {brew, pipx, go};
}
/** The install command this machine can actually run (Homebrew on macOS or Linux, else pipx or go), or undefined when it must be installed by hand. */
export function toolCommand(tool: InstallableTool, platform: NodeJS.Platform, installers: Installers): string | undefined {
  if (platform === "win32") return undefined;
  if (installers.brew) return installCommands[tool].darwin;
  const other = installCommands[tool].other;
  return other.startsWith("pipx ") && installers.pipx || other.startsWith("go ") && installers.go ? other : undefined;
}
/** Where to install an analyzer by hand when setup cannot. */
export const manualInstall = (tool: InstallableTool): string =>
  installCommands[tool].label + ": " + ({trivy: "https://trivy.dev/latest/getting-started/installation/", findsecbugs: "https://spotbugs.readthedocs.io/en/latest/installing.html",
    semgrep: "https://semgrep.dev/docs/getting-started/", bandit: "https://bandit.readthedocs.io/en/latest/start.html", gitleaks: "https://github.com/gitleaks/gitleaks#installing",
    gosec: "https://github.com/securego/gosec#install", "osv-scanner": "https://google.github.io/osv-scanner/installation/"} as Record<InstallableTool, string>)[tool];
/** What this machine has, and what the user chose, before setup runs. */
export interface SetupState {
  platform: NodeJS.Platform; root?: string;
  ollama: boolean; installer?: string; running: boolean;
  model: string; modelReady: boolean;
  tools: InstallableTool[]; osvInstalled: boolean; osvDatabase: boolean;
  /** Defaults to Homebrew on macOS and nothing elsewhere. */
  installers?: Installers;
}
export interface SetupStep { kind: "ollama-install" | "ollama-start" | "model" | "tool" | "osv-database"; label: string; command: string; tool?: InstallableTool }

/** The steps that bring this machine to a working setup, in order: Ollama, its server, the model, then the chosen analyzers. */
export function setupPlan(state: SetupState): SetupStep[] {
  const steps: SetupStep[] = [];
  if (!state.ollama && state.installer) steps.push({kind: "ollama-install", label: "Install Ollama", command: state.installer});
  if (!state.running) steps.push({kind: "ollama-start", label: "Start the local Ollama server (127.0.0.1 only)", command: "ollama serve"});
  if (!state.modelReady) steps.push({kind: "model", label: "Download the model " + state.model + " (several GB, once)", command: "ollama pull " + state.model});
  if (state.platform === "win32") return steps;
  const installers = state.installers ?? {brew: state.platform === "darwin", pipx: false, go: false};
  const tools = state.tools.flatMap(tool => { const command = toolCommand(tool, state.platform, installers); return command ? [{tool, command}] : []; });
  for (const {tool, command} of tools)
    steps.push({kind: "tool", tool, label: "Install " + installCommands[tool].label + " (" + installCommands[tool].purpose + ")", command});
  if (state.root && !state.osvDatabase && (state.osvInstalled || tools.some(t => t.tool === "osv-scanner")))
    steps.push({kind: "osv-database", label: "Download the OSV offline vulnerability database (public data, no code sent)", command: osvDatabaseCommand(state.root)});
  return steps;
}

/** How Ollama is installed on this platform (Homebrew, WinGet, the official script), or undefined elsewhere. */
export function ollamaInstaller(platform = process.platform): {tool: string; executable: string; args: string[]; command: string; download: string} | undefined {
  const installers: Partial<Record<NodeJS.Platform, {tool: string; executable: string; args: string[]; command: string; page: string}>> = {
    darwin: {tool: "Homebrew", executable: "brew", args: ["--version"], command: "brew install ollama", page: "mac"},
    win32: {tool: "WinGet", executable: "winget", args: ["--version"], command: "winget install --id Ollama.Ollama --exact", page: "windows"},
    linux: {tool: "curl and sh", executable: "sh", args: ["-c", "command -v curl"], command: "curl -fsSL https://ollama.com/install.sh | sh", page: "linux"}
  };
  const found = installers[platform];
  return found && {...found, download: "https://ollama.com/download/" + found.page};
}

/** Whether a command-line program runs (`--version` style probe). */
export const runs = (executable: string, args: string[]): Promise<boolean> => new Promise(resolve =>
  execFile(executable, args, {cwd: homedir(), timeout: 5000, windowsHide: true}, error => resolve(!error)));
export const hasInstaller = (installer: {executable: string; args: string[]}): Promise<boolean> => runs(installer.executable, installer.args);
