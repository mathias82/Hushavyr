/** The global `hushavyr` command: a small launcher in a folder on PATH that runs the CLI bundled with the installed extension. */
import {chmod, mkdir, readFile, writeFile} from "node:fs/promises";
import {delimiter, join} from "node:path";

export const SHIM_MARKER = "Created by the Hushavyr VS Code extension";

/** Where the launcher goes: ~/.local/bin on macOS and Linux, the per-user WindowsApps folder (already on PATH) on Windows. */
export function shimPath(platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv): string {
  if (platform === "win32") return join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "Microsoft", "WindowsApps", "hushavyr.cmd");
  return join(home, ".local", "bin", "hushavyr");
}

/** Launcher text. Node from PATH is preferred; otherwise the editor's own runtime (`nodePath`) runs the CLI in Node mode. */
export function shimScript(platform: NodeJS.Platform, extensionPath: string, nodePath: string): string {
  if (platform === "win32") return [
    "@echo off",
    "rem " + SHIM_MARKER + "; it is updated when the extension updates.",
    "if not defined HUSHAVYR_NODE set \"HUSHAVYR_NODE=" + nodePath + "\"",
    "if not exist \"" + extensionPath + "\\bin\\hushavyr.cmd\" (echo hushavyr: the Hushavyr extension was removed or moved. Open VS Code once to update this command. 1>&2 & exit /b 1)",
    "call \"" + extensionPath + "\\bin\\hushavyr.cmd\" %*", ""].join("\r\n");
  const q = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
  return [
    "#!/bin/sh",
    "# " + SHIM_MARKER + "; it is updated when the extension updates.",
    "launcher=" + q(join(extensionPath, "bin", "hushavyr")),
    "if [ ! -f \"$launcher\" ]; then echo 'hushavyr: the Hushavyr extension was removed or moved. Open VS Code once to update this command.' >&2; exit 1; fi",
    "HUSHAVYR_NODE=\"${HUSHAVYR_NODE:-" + nodePath.replace(/["$`\\]/g, "\\$&") + "}\" exec sh \"$launcher\" \"$@\"", ""].join("\n");
}

/** Whether `dir` is one of the PATH entries. */
export function onPath(dir: string, pathValue = "", platform: NodeJS.Platform = process.platform): boolean {
  const norm = (p: string) => (platform === "win32" ? p.toLowerCase() : p).replace(/[\\/]+$/, "");
  return pathValue.split(platform === "win32" ? ";" : delimiter).some(entry => entry && norm(entry) === norm(dir));
}

/** The shell startup file that adds ~/.local/bin to PATH, for the user's login shell. */
export function profileFile(shell: string | undefined, platform: NodeJS.Platform, home: string): string {
  if (/fish$/.test(shell ?? "")) return join(home, ".config", "fish", "config.fish");
  if (/bash$/.test(shell ?? "")) return join(home, platform === "darwin" ? ".bash_profile" : ".bashrc");
  return join(home, ".zshrc");
}
export const pathLine = (shell: string | undefined): string =>
  /fish$/.test(shell ?? "") ? "fish_add_path $HOME/.local/bin" : "export PATH=\"$HOME/.local/bin:$PATH\"";

/** Writes the launcher; returns false when a file that Hushavyr did not create is already there. */
export async function writeShim(path: string, script: string): Promise<boolean> {
  const current = await readFile(path, "utf8").catch(() => undefined);
  if (current !== undefined && !current.includes(SHIM_MARKER)) return false;
  if (current === script) return true;
  await mkdir(join(path, ".."), {recursive: true});
  await writeFile(path, script);
  await chmod(path, 0o755).catch(() => undefined);
  return true;
}

/** Rewrites an existing launcher so it points at the current extension version; does nothing when none was installed. */
export async function refreshShim(path: string, script: string): Promise<void> {
  const current = await readFile(path, "utf8").catch(() => undefined);
  if (current?.includes(SHIM_MARKER) && current !== script) await writeShim(path, script);
}
