import {configuredModel} from "./model";
import {execFile} from "node:child_process";
import {homedir} from "node:os";
import * as vscode from "vscode";

/** Starts `ollama serve` in a visible terminal. Flash attention and an 8-bit KV cache roughly halve context memory with no visible quality loss. */
export function startOllamaServer(): vscode.Terminal {
  const terminal = vscode.window.createTerminal({name: "Hushavyr: Ollama server", cwd: homedir(), env: {OLLAMA_FLASH_ATTENTION: "1", OLLAMA_KV_CACHE_TYPE: "q8_0"}});
  terminal.show(true);
  terminal.sendText("ollama serve");
  return terminal;
}

// Only the user can approve installing an external executable. No silent downloads.
/** Ollama install, serve and model-download commands; each runs only after a modal confirmation in a visible terminal. */
export function registerOllamaCommands(context: vscode.ExtensionContext): void {
  for (const task of [
    {id: "startOllama", title: "Ollama server", args: () => ["serve"]},
    {id: "downloadOllamaModel", title: "Local model download", args: () => ["pull", configuredModel(vscode.workspace.getConfiguration("aiPrivacyRouter"))]}
  ]) {
    context.subscriptions.push(vscode.commands.registerCommand("aiPrivacyRouter." + task.id, async () => {
      if (!vscode.workspace.isTrusted || vscode.env?.remoteName) {
        await vscode.window.showInformationMessage("Open a trusted local VS Code window to set up Ollama.");
        return;
      }
      const command = ["ollama", ...task.args()].join(" ");
      const action = await vscode.window.showInformationMessage("Run " + command + "?", {modal: true}, "Run in Terminal");
      if (action !== "Run in Terminal") return;
      if (task.id === "startOllama") { startOllamaServer(); return; }
      const terminal = vscode.window.createTerminal({name: "Hushavyr: " + task.title, cwd: homedir()});
      terminal.show();
      terminal.sendText(command);
    }));
  }
  context.subscriptions.push(vscode.commands.registerCommand("aiPrivacyRouter.installOllama", async () => {
    if (!vscode.workspace.isTrusted || vscode.env?.remoteName) {
      await vscode.window.showInformationMessage("Open a trusted local VS Code window to install Ollama.");
      return;
    }
    const installer = ollamaInstaller();
    if (!installer) {
      await vscode.env.openExternal(vscode.Uri.parse("https://ollama.com/download"));
      return;
    }
    const {tool, command} = installer, download = vscode.Uri.parse(installer.download);
    if (!await hasInstaller(installer)) {
      const action = await vscode.window.showInformationMessage(
        tool + " is unavailable. Download and install Ollama first, then return to the Hushavyr guide.",
        "Download Ollama");
      if (action === "Download Ollama") await vscode.env.openExternal(download);
      return;
    }
    const action = await vscode.window.showInformationMessage("Run the Ollama installer in the VS Code terminal?",
      {modal: true, detail: command}, "Run installer", "Open download page");
    if (action === "Open download page") {
      await vscode.env.openExternal(download);
    } else if (action === "Run installer") {
      const terminal = vscode.window.createTerminal({name: "Hushavyr: Ollama setup", cwd: homedir()});
      terminal.show();
      terminal.sendText(command);
    }
  }));
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
