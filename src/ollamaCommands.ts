import {configuredModel} from "./model";
import {execFile} from "node:child_process";
import {homedir} from "node:os";
import * as vscode from "vscode";

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
      // Flash attention and an 8-bit KV cache roughly halve context memory with no visible quality loss.
      const terminal = vscode.window.createTerminal({name: "Hushavyr: " + task.title, cwd: homedir(),
        env: task.id === "startOllama" ? {OLLAMA_FLASH_ATTENTION: "1", OLLAMA_KV_CACHE_TYPE: "q8_0"} : undefined});
      terminal.show();
      terminal.sendText(command);
    }));
  }
  context.subscriptions.push(vscode.commands.registerCommand("aiPrivacyRouter.installOllama", async () => {
    if (!vscode.workspace.isTrusted || vscode.env?.remoteName) {
      await vscode.window.showInformationMessage("Open a trusted local VS Code window to install Ollama.");
      return;
    }
    const installers = {
      darwin: {tool: "Homebrew", executable: "brew", args: ["--version"], command: "brew install ollama", page: "mac"},
      win32: {tool: "WinGet", executable: "winget", args: ["--version"], command: "winget install --id Ollama.Ollama --exact", page: "windows"},
      linux: {tool: "curl and sh", executable: "sh", args: ["-c", "command -v curl"], command: "curl -fsSL https://ollama.com/install.sh | sh", page: "linux"}
    };
    const platform = process.platform;
    if (platform !== "darwin" && platform !== "win32" && platform !== "linux") {
      await vscode.env.openExternal(vscode.Uri.parse("https://ollama.com/download"));
      return;
    }
    const {tool, executable, args, command, page} = installers[platform];
    const download = vscode.Uri.parse("https://ollama.com/download/" + page);
    const available = await new Promise<boolean>(resolve => {
      execFile(executable, args, {cwd: homedir(), timeout: 5000, windowsHide: true}, error => resolve(!error));
    });
    if (!available) {
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
