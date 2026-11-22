/** /setup in the terminal: the same plan as Hushavyr: Setup in VS Code, run in this terminal after one confirmation. */
import {spawn} from "node:child_process";
import {readdir} from "node:fs/promises";
import {homedir} from "node:os";
import {join} from "node:path";
import {hasOsvDatabase} from "../codeScanners";
import {LocalOllama} from "../ollama";
import {detectTools, hasInstaller, installCommands, InstallableTool, OLLAMA_SERVE_ENV, ollamaInstaller, relevantTools, runs, setupPlan} from "../setupSteps";

export interface SetupIO {
  out(text: string): void;
  dim(text: string): string;
  ask(question: string): Promise<boolean>;
  /** Hands the terminal to a child process (installers may ask for a password) and takes it back. */
  suspend(): void;
  resume(): void;
  signal: AbortSignal;
}

const SKIP = new Set([".git", "node_modules", "target", "build", "dist", "out", ".venv", "venv", "vendor", "__pycache__"]);
/** Which analyzers this folder can use: Python files, a Go module, a Maven or Gradle build (a shallow, bounded walk). */
export async function projectKinds(root: string): Promise<{python: boolean; go: boolean; jvm: boolean}> {
  const has = {python: false, go: false, jvm: false};
  let seen = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 4 || seen > 3000) return;
    for (const entry of await readdir(dir, {withFileTypes: true}).catch(() => [])) {
      seen++;
      if (entry.isDirectory()) { if (!SKIP.has(entry.name) && !entry.name.startsWith(".")) await walk(join(dir, entry.name), depth + 1); continue; }
      if (entry.name.endsWith(".py")) has.python = true;
      else if (entry.name === "go.mod") has.go = true;
      else if (/^(?:pom\.xml|build\.gradle(?:\.kts)?)$/.test(entry.name)) has.jvm = true;
    }
  };
  await walk(root, 0);
  return has;
}

const run = (command: string): Promise<number | null> => new Promise(resolve => {
  const child = spawn(command, {shell: true, stdio: "inherit", cwd: homedir()});
  child.on("error", () => resolve(null));
  child.on("exit", code => resolve(code));
});
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Detects what is missing, lists every command, asks once, then installs and starts Ollama, downloads the model and installs the analyzers. */
export async function terminalSetup(io: SetupIO, endpoint: string, model: string, root: string): Promise<boolean> {
  const platform = process.platform;
  const probe = new LocalOllama({model, endpoint});
  io.out(io.dim("Checking Ollama, the model and the analyzers…"));
  const [running, ollama, installer, tools, osvDatabase, kinds] = await Promise.all([
    probe.isRunning(), runs("ollama", ["--version"]),
    (async () => { const found = ollamaInstaller(platform); return found && await hasInstaller(found) ? found.command : undefined; })(),
    detectTools(), hasOsvDatabase(), projectKinds(root)]);
  if (!ollama && !running && !installer) {
    io.out("Ollama is not installed and no installer (Homebrew, WinGet, curl) was found. Install it from " + (ollamaInstaller(platform)?.download ?? "https://ollama.com/download") + ", then run /setup again.");
    return false;
  }
  const installed = running ? await probe.listModels().catch(() => [] as string[]) : [];
  const relevant = new Set(relevantTools(tools, kinds));
  const missing = platform === "win32" ? [] : (Object.keys(tools) as InstallableTool[]).filter(t => !tools[t]).sort((a, b) => Number(relevant.has(b)) - Number(relevant.has(a)));
  let chosen: InstallableTool[] = [];
  if (missing.length) {
    io.out("Missing dependency and security analyzers: " + missing.map(t => installCommands[t].label).join(", "));
    if (await io.ask("Install them too?")) chosen = missing;
  }
  const steps = setupPlan({platform, root, ollama, installer, running, model, modelReady: installed.includes(model), tools: chosen, osvInstalled: tools["osv-scanner"], osvDatabase});
  if (!steps.length) { io.out("Everything is set up: Ollama is running and " + model + " is downloaded."); return true; }
  io.out("Setup will run " + steps.length + " step(s) on this machine:");
  steps.forEach((step, i) => io.out("  " + (i + 1) + ". " + step.label + "\n     " + io.dim(step.command)));
  io.out(io.dim("Downloads come from the package managers and ollama.com; no project code is sent."));
  if (!await io.ask("Run setup?")) { io.out("Nothing was changed."); return false; }
  const failed: string[] = [];
  for (const [i, step] of steps.entries()) {
    if (io.signal.aborted) { failed.push("cancelled"); break; }
    io.out("\n[" + (i + 1) + "/" + steps.length + "] " + step.label);
    if (step.kind === "ollama-start") {
      const server = spawn("ollama", ["serve"], {detached: true, stdio: "ignore", cwd: homedir(), env: {...process.env, ...OLLAMA_SERVE_ENV}, windowsHide: true});
      server.on("error", () => undefined);
      server.unref();
      let up = false;
      for (let t = 0; t < 30 && !up && !io.signal.aborted; t++) { await wait(1000); up = await probe.isRunning(); }
      if (!up) { failed.push("the Ollama server did not start (run `ollama serve` to see why)"); break; }
      io.out(io.dim("  Ollama is running on " + endpoint));
    } else if (step.kind === "model") {
      let last = -1;
      try {
        await probe.ensureInstalled(io.signal, percent => {
          if (percent === undefined || percent === last) return;
          last = percent;
          process.stdout.write("\r  " + model + ": " + percent + "%   ");
        });
        io.out("\r  " + model + ": downloaded      ");
      } catch (error) {
        failed.push("downloading " + model + ": " + (error as Error).message.replace(/\.$/, ""));
      }
    } else {
      io.suspend();
      const code = await run(step.command);
      io.resume();
      // osv-scanner exits non-zero when the project has vulnerabilities; the step succeeded if the database is there.
      if (step.kind === "osv-database" ? !await hasOsvDatabase() : code !== 0) {
        failed.push(step.label + " (exit code " + (code ?? "unknown") + ")");
        if (step.kind === "ollama-install") break;
      }
    }
  }
  if (failed.length) io.out("\nSetup did not finish: " + failed.join("; ") + ". Fix it and run /setup again; finished steps are skipped.");
  else io.out("\nSetup finished: Ollama is running with " + model + ".");
  return !failed.length;
}
