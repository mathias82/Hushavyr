/** Sends one approved prompt to GitHub Copilot through the Copilot CLI, with no tools, no files and no MCP servers. */
import {spawn} from "node:child_process";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {existsSync} from "node:fs";

export function copilotArgs(prompt: string): string[] {
  return ["-p", prompt, "-s", "--available-tools=", "--disable-builtin-mcps", "--no-custom-instructions", "--no-ask-user"];
}

const INSTALL = "The Copilot CLI is not installed. Install it with " + (process.platform === "win32" ? "winget install GitHub.Copilot" : process.platform === "darwin" ? "brew install copilot-cli" : "npm install -g @github/copilot") +
  ", then run copilot once to log in.";

/**
 * The program to start, never through a shell: the prompt must stay one argv entry.
 * On Windows npm installs only a copilot.cmd shim (which needs cmd.exe), so its JavaScript entry runs with Node instead.
 */
export function resolveCopilot(override: string | undefined, platform: NodeJS.Platform, path: string, exists: (file: string) => boolean = existsSync,
  node = process.execPath): {file: string; args: string[]} | undefined {
  const script = (file: string) => ({file: node, args: [file]});
  if (override) {
    if (/\.(?:cmd|bat)$/i.test(override)) return undefined;
    return /\.[cm]?js$/i.test(override) ? script(override) : {file: override, args: []};
  }
  if (platform !== "win32") return {file: "copilot", args: []};
  for (const dir of path.split(platform === "win32" ? ";" : ":").filter(Boolean)) {
    if (exists(join(dir, "copilot.exe"))) return {file: join(dir, "copilot.exe"), args: []};
    const loader = join(dir, "node_modules", "@github", "copilot", "npm-loader.js");
    if (exists(join(dir, "copilot.cmd")) && exists(loader)) return script(loader);
  }
  return undefined;
}

export async function copilotSend(prompt: string, signal?: AbortSignal): Promise<string> {
  const program = resolveCopilot(process.env.HUSHAVYR_COPILOT || undefined, process.platform, process.env.PATH ?? process.env.Path ?? "");
  if (!program) throw new Error(INSTALL);
  // An empty folder, so the CLI cannot read any project file even if a tool slipped through.
  const cwd = await mkdtemp(join(tmpdir(), "hushavyr-escalate-"));
  try {
    return await new Promise<string>((resolve, reject) => {
      const child = spawn(program.file, [...program.args, ...copilotArgs(prompt)], {cwd, stdio: ["ignore", "pipe", "pipe"], signal});
      let out = "", err = "";
      child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
      child.stderr.on("data", (d: Buffer) => { err += d.toString(); });
      child.on("error", (e: NodeJS.ErrnoException) => reject(new Error(e.code === "ENOENT" ? INSTALL : e.message)));
      child.on("close", code => code === 0 && out.trim() ? resolve(out.trim())
        : reject(new Error("Copilot CLI failed" + (err.trim() ? ": " + err.trim().split("\n")[0].slice(0, 200) : "") + ". Run copilot once to log in.")));
    });
  } finally {
    await rm(cwd, {recursive: true, force: true});
  }
}
