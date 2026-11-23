/** VS Code side of the `hushavyr` terminal command: PATH for VS Code terminals and an optional global launcher. */
import {appendFile, chmod, readFile} from "node:fs/promises";
import {homedir} from "node:os";
import {delimiter, dirname, join} from "node:path";
import * as vscode from "vscode";
import {onPath, pathLine, profileFile, refreshShim, shimPath, shimScript, writeShim} from "./shim";

export const INSTALL_TERMINAL_COMMAND = "aiPrivacyRouter.installTerminalCommand";

export function registerTerminalCommand(context: vscode.ExtensionContext): void {
  const bin = context.asAbsolutePath("bin");
  // VSIX extraction can drop the executable bit.
  for (const name of ["hushavyr", "hushavyr.cmd"]) void chmod(join(bin, name), 0o755).catch(() => undefined);
  // Terminals opened in VS Code find `hushavyr` without any install step.
  const env = context.environmentVariableCollection;
  if (env) {
    env.description = "Adds the hushavyr command (private AI code review) to terminals.";
    env.prepend("PATH", bin + delimiter);
    env.replace("HUSHAVYR_NODE", process.execPath);
  }
  const target = shimPath(process.platform, homedir(), process.env);
  const script = shimScript(process.platform, context.extensionPath ?? dirname(bin), process.execPath);
  // Only the installed extension updates the user's launcher; test and development hosts must not repoint it.
  if (context.extensionPath && context.extensionMode === vscode.ExtensionMode.Production) void refreshShim(target, script).catch(() => undefined);
  context.subscriptions.push(vscode.commands.registerCommand(INSTALL_TERMINAL_COMMAND, () => installTerminalCommand(target, script)));
}

async function installTerminalCommand(target: string, script: string): Promise<void> {
  if (!await writeShim(target, script)) {
    void vscode.window.showWarningMessage(`Hushavyr: ${target} already exists and was not created by Hushavyr, so it was left unchanged.`);
    return;
  }
  const dir = dirname(target);
  if (process.platform === "win32" || onPath(dir, process.env.PATH)) {
    void vscode.window.showInformationMessage(`Hushavyr: type "hushavyr" in any new terminal. Installed at ${target}.`);
    return;
  }
  const profile = profileFile(process.env.SHELL, process.platform, homedir());
  const line = pathLine(process.env.SHELL);
  const current = await readFile(profile, "utf8").catch(() => "");
  if (current.includes(line)) {
    void vscode.window.showInformationMessage(`Hushavyr: installed at ${target}. Open a new terminal and type "hushavyr".`);
    return;
  }
  const choice = await vscode.window.showInformationMessage(
    `Hushavyr: installed at ${target}, but ${dir} is not on your PATH. Add it to ${profile}?`, "Add to PATH", "Not now");
  if (choice !== "Add to PATH") return;
  await appendFile(profile, `${current && !current.endsWith("\n") ? "\n" : ""}# Added by Hushavyr\n${line}\n`);
  void vscode.window.showInformationMessage(`Hushavyr: open a new terminal and type "hushavyr".`);
}
