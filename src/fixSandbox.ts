import {execFile, spawn} from "node:child_process";
import {constants} from "node:fs";
import {cp, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, writeFile} from "node:fs/promises";
import {homedir} from "node:os";
import {dirname, isAbsolute, join, relative, resolve, sep} from "node:path";
import {randomUUID} from "node:crypto";
import {FixProofContext, FixProofReceipt, ProofStage, SourceChange, TestRun, TestCase, parseNodeReport, parsePytestReport, parseSurefire, sha256} from "./fixProof";

export function safeRelative(path: string): string {
  if (!path || isAbsolute(path) || /[\\\x00-\x1f]/.test(path) ||
    path.split("/").some(s => !s || s === "." || s === ".." || s === ".git")) throw new Error("invalid-relative-path");
  return path;
}
function at(root: string, path: string): string {
  const full = resolve(root, safeRelative(path));
  if (!full.startsWith(root + sep)) throw new Error("path-outside-snapshot");
  return full;
}
const environment = (): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: homedir(), LANG: "C", GIT_TERMINAL_PROMPT: "0"
});
async function command(file: string, args: string[], cwd: string): Promise<Buffer> {
  return new Promise((yes, no) => execFile(file, args, {cwd, env: environment(), encoding: "buffer",
    timeout: 30000, maxBuffer: 4 * 1024 * 1024}, (error, stdout) =>
    error ? no(new Error("local-tool-failed")) : yes(stdout)));
}
function git(args: string[], cwd: string): Promise<Buffer> {
  return command("git", ["-c", "core.fsmonitor=false", ...args], cwd);
}
interface DockerMounts {profile?: "python" | "node" | "typescript"; snapshot: string; target: string; cache?: string; project: string; image: string; uid: number; gid: number; name: string}
export function dockerCreateArgs(input: DockerMounts, targetClass?: string): string[] {
  for (const path of [input.snapshot, input.target, ...(input.cache ? [input.cache] : [])]) {
    if (!isAbsolute(path) || /[,\x00-\x1f]/.test(path)) throw new Error("unsupported-mount-path");
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(input.image) || !/^ai-privacy-fix-[a-f0-9-]{36}$/.test(input.name) ||
    !Number.isInteger(input.uid) || input.uid <= 0 || !Number.isInteger(input.gid) || input.gid < 0) throw new Error("invalid-sandbox-config");
  if (input.project) safeRelative(input.project);
  if (input.profile !== "node" && input.profile !== "typescript" && targetClass && !/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(targetClass)) throw new Error("invalid-test-selector");
  const project = "/work" + (input.project ? "/" + input.project : "");
  const isolated = ["create", "--name", input.name, "--pull=never", "--network=none", "--read-only",
    "--cap-drop=ALL", "--security-opt=no-new-privileges:true", "--pids-limit=256",
    "--memory=4g", "--cpus=2", "--log-driver=none", "--user", input.uid + ":" + input.gid,
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=536870912",
    "--mount", "type=bind,src=" + input.snapshot + ",dst=/work,readonly"];
  if (input.profile === "node" || input.profile === "typescript") {
    if (targetClass && !/^hushavyr-[a-f0-9]{32}\.test\.cjs$/.test(targetClass)) throw new Error("invalid-node-test-selector");
    const runner = input.profile === "typescript"
      ? ["--entrypoint", "sh", input.image, "-c",
        'tsc --project tsconfig.json --noEmit --incremental false && exec node "$@"', "hushavyr"]
      : ["--entrypoint", "node", input.image];
    return [...isolated, "--mount", "type=bind,src=" + input.target + ",dst=/reports",
      "--workdir", project, "--env", "HOME=/tmp", ...runner,
      "--test", "--test-reporter=junit", "--test-reporter-destination=/reports/node.xml",
      ...(targetClass ? ["test/" + targetClass] : [])];
  }
  if (!input.cache) {
    if (targetClass && !/^test_hushavyr_[a-f0-9]{32}$/.test(targetClass)) throw new Error("invalid-python-test-selector");
    return [...isolated, "--mount", "type=bind,src=" + input.target + ",dst=/reports",
      "--workdir", project, "--env", "HOME=/tmp", "--env", "PYTHONDONTWRITEBYTECODE=1",
      "--env", "PYTEST_DISABLE_PLUGIN_AUTOLOAD=1", "--entrypoint", "python", input.image,
      "-m", "pytest", "-o", "addopts=", "-p", "no:cacheprovider", "--junitxml=/reports/pytest.xml",
      targetClass ? "tests/" + targetClass + ".py" : "tests"];
  }
  return [...isolated, "--mount", "type=bind,src=" + input.target + ",dst=" + project + "/target",
    "--mount", "type=bind,src=" + input.cache + ",dst=/m2,readonly",
    "--workdir", project, "--env", "HOME=/tmp", "--env", "MAVEN_CONFIG=/tmp/.m2",
    "--env", "MAVEN_OPTS=-Duser.home=/tmp", "--entrypoint", "mvn", input.image,
    "--offline", "--batch-mode", "--no-transfer-progress", "-Dmaven.repo.local=/m2",
    "-DskipTests=false", "-Dmaven.test.skip=false", "-DfailIfNoTests=true",
    "-Dsurefire.failIfNoSpecifiedTests=true", ...(targetClass ? ["-Dtest=" + targetClass] : []), "test"];
}
async function attach(args: string[], cwd: string, timeoutMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return true;
  return new Promise(resolve => {
    let interrupted = false;
    const child = spawn("docker", args, {cwd, env: environment(), stdio: "ignore", shell: false});
    const stop = (): void => {interrupted = true; child.kill("SIGKILL");};
    const timer = setTimeout(stop, timeoutMs);
    signal.addEventListener("abort", stop, {once: true});
    if (signal.aborted) stop();
    const finish = (): void => {clearTimeout(timer); signal.removeEventListener("abort", stop); resolve(interrupted);};
    child.once("error", () => {interrupted = true; finish();});
    child.once("close", finish);
  });
}
async function regularBytes(path: string, maxBytes: number): Promise<Buffer> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes) throw new Error("invalid-file");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes || info.ino !== before.ino || info.dev !== before.dev) throw new Error("invalid-file");
    return await handle.readFile();
  } finally {await handle.close();}
}
async function regularText(path: string, maxBytes: number): Promise<string> {
  return (await regularBytes(path, maxBytes)).toString("utf8");
}
export interface FixSandboxOptions {
  project: string; selected: string[]; storage: string; image: string; cache?: string; profile?: "python" | "node" | "typescript"; signal: AbortSignal;
}
export class FixSandbox {
  readonly context: FixProofContext;
  readonly sources: {path: string; text: string}[];
  private readonly expected = new Map<string, string>();
  private readonly original = new Map<string, string>();
  private testSource?: string;
  private changes: SourceChange[] = [];
  private unsafeCleanup = false;
  private constructor(
    readonly directory: string, private readonly snapshot: string, private readonly project: string,
    private readonly targetDirectory: string, private readonly docker: string[],
    private readonly cache: string | undefined, readonly contextSources: {path: string; text: string}[],
    context: FixProofContext, private readonly signal: AbortSignal
  ) {this.context = context; this.sources = contextSources;}
  static async create(options: FixSandboxOptions): Promise<FixSandbox> {
    if (process.platform === "win32" || !process.getuid || process.getuid() === 0) throw new Error("non-root-macos-or-linux-required");
    if (options.signal.aborted) throw new Error("cancelled");
    const projectPath = await realpath(options.project);
    const root = (await git(["rev-parse", "--show-toplevel"], projectPath)).toString("utf8").trim();
    const rootPath = await realpath(root);
    const project = relative(rootPath, projectPath).split(sep).join("/");
    if (project) safeRelative(project);
    const staged = await git(["diff", "--cached", "--name-only", "-z", "--no-ext-diff", "--no-textconv", "HEAD", "--"], rootPath);
    if (staged.length) throw new Error("commit-local-changes-first");
    const baseCommit = (await git(["rev-parse", "--verify", "HEAD^{commit}"], rootPath)).toString("utf8").trim();
    if (!/^[a-f0-9]{40,64}$/.test(baseCommit)) throw new Error("invalid-base");
    const entries = (await git(["ls-tree", "-rlz", baseCommit], rootPath)).toString("utf8").split("\0").filter(Boolean);
    if (entries.length > 10000) throw new Error("snapshot-too-large");
    await mkdir(options.storage, {recursive: true, mode: 0o700});
    const directory = await mkdtemp(join(options.storage, "fix-"));
    const snapshot = join(directory, "snapshot"), targetDirectory = join(directory, "build-target");
    try {
      await mkdir(snapshot, {mode: 0o700});
      let total = 0;
      const texts = new Map<string, Buffer>();
      for (const entry of entries) {
        if (options.signal.aborted) throw new Error("cancelled");
        const match = /^([0-9]{6}) blob ([a-f0-9]{40,64}) +([0-9]+)\t(.+)$/.exec(entry);
        if (!match || !["100644", "100755"].includes(match[1])) throw new Error("symlinks-or-submodules-not-supported");
        const path = safeRelative(match[4]), size = Number(match[3]);
        if (size > 2097152 || (total += size) > 67108864) throw new Error("snapshot-too-large");
        const original = at(rootPath, path), info = await lstat(original);
        if (!info.isFile() || info.isSymbolicLink() || await realpath(original) !== original) throw new Error("unsupported-source");
        const bytes = await git(["cat-file", "blob", match[2]], rootPath);
        if (!bytes.equals(await readFile(original))) throw new Error("commit-local-changes-first");
        const destination = at(snapshot, path);
        await mkdir(dirname(destination), {recursive: true});
        await writeFile(destination, bytes, {mode: match[1] === "100755" ? 0o755 : 0o644});
        texts.set(path, bytes);
      }
      const prefix = project ? project + "/" : "";
      const python = options.profile === "python";
      const typescript = options.profile === "typescript";
      const node = options.profile === "node" || typescript;
      if (typescript && !texts.has(prefix + "tsconfig.json")) throw new Error("tracked-tsconfig-required");
      const pomPath = prefix + "pom.xml", pom = texts.get(pomPath)?.toString("utf8");
      if (!python && !node && (!pom || /<modules\b/i.test(pom.replace(/<!--[\s\S]*?-->/g, "")))) throw new Error("select-a-leaf-maven-project");
      if (!options.selected.length || options.selected.length > 6) throw new Error("select-one-to-six-java-files");
      if (python && ![...texts.keys()].some(path => path.startsWith(prefix + "tests/") && path.endsWith(".py"))) {
        throw new Error("tracked-pytest-suite-required");
      }
      const sources: {path: string; text: string}[] = python || node ? [] : [{path: pomPath, text: pom!}];
      for (const absolute of options.selected) {
        const path = relative(rootPath, await realpath(absolute)).split(sep).join("/");
        safeRelative(path);
        const allowed = node
          ? path.startsWith(prefix) && (typescript ? /\.(?:ts|cts|mts)$/.test(path) && !/\.d\.[cm]?ts$/.test(path) : /\.[cm]?js$/.test(path)) &&
            !/(?:^|\/)(?:tests?|__tests__|node_modules)(?:\/|$)|(?:[-_.](?:spec|test)|\.config)\.[cm]?[jt]s$/.test(path)
          : python
          ? path.startsWith(prefix) && path.endsWith(".py") && !/(?:^|\/)(?:tests?|test_[^/]*|[^/]*_test\.py|conftest\.py|setup\.py)(?:\/|$)/.test(path)
          : path.startsWith(prefix + "src/main/java/") && path.endsWith(".java");
        if (!allowed || !texts.has(path)) throw new Error("select-tracked-production-source");
        if (sources.some(s => s.path === path)) throw new Error("duplicate-source");
        sources.push({path, text: texts.get(path)!.toString("utf8")});
      }
      if (Buffer.byteLength(JSON.stringify(sources), "utf8") > 12000) throw new Error("model-context-exceeds-12kb");
      if (!python && !node && [...texts.keys()].some(path => path === prefix + "target" || path.startsWith(prefix + "target/"))) throw new Error("tracked-build-output-not-supported");
      const endpoint = JSON.parse((await command("docker", ["context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"], directory)).toString("utf8").trim());
      if (typeof endpoint !== "string" || !endpoint.startsWith("unix:///") || /[,\x00-\x1f]/.test(endpoint)) throw new Error("local-unix-docker-context-required");
      const config = join(directory, "docker-config"); await mkdir(config, {mode: 0o700});
      const docker = ["--host", endpoint, "--config", config];
      if (!/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,255}$/.test(options.image)) throw new Error("invalid-image");
      const imageId = (await command("docker", [...docker, "image", "inspect", options.image, "--format", "{{.Id}}"], directory)).toString("utf8").trim();
      if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new Error("preload-a-local-maven-image");
      if (python || node) {
        const suffix = randomUUID().replace(/-/g, "");
        const testClass = node ? "hushavyr-" + suffix + ".test.cjs" : "test_hushavyr_" + suffix;
        const testPath = prefix + (node ? "test/" + testClass : "tests/" + testClass + ".py");
        const context: FixProofContext = {baseCommit, imageId, testClass, testPath, profile: options.profile};
        if (texts.has(context.testPath)) throw new Error("test-path-exists");
        const sandbox = new FixSandbox(directory, snapshot, project, targetDirectory, docker, undefined, sources, context, options.signal);
        for (const [path, bytes] of texts) sandbox.expected.set(path, sha256(bytes));
        for (const source of sources) sandbox.original.set(source.path, source.text);
        return sandbox;
      }
      const cacheSource = await realpath(options.cache ?? join(homedir(), ".m2", "repository"));
      if (!(await lstat(cacheSource)).isDirectory()) throw new Error("maven-cache-required");
      const cache = join(directory, "maven-cache");
      let cacheBytes = 0, cacheFiles = 0;
      await cp(cacheSource, cache, {recursive: true, dereference: false, force: false, errorOnExist: true,
        mode: constants.COPYFILE_FICLONE, filter: async path => {
          if (options.signal.aborted) throw new Error("cancelled");
          const info = await lstat(path);
          if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw new Error("unsupported-cache-entry");
          if (info.isFile() && (info.size > 268435456 || (cacheBytes += info.size) > 4294967296 || ++cacheFiles > 100000)) {
            throw new Error("dependency-cache-too-large");
          }
          return true;
        }});
      const dependencyHashes: string[] = [];
      const inspectCache = async (path: string): Promise<void> => {
        if (options.signal.aborted) throw new Error("cancelled");
        for (const name of (await readdir(path)).sort()) {
          if (options.signal.aborted) throw new Error("cancelled");
          const child = join(path, name), info = await lstat(child);
          if (info.isDirectory() && !info.isSymbolicLink()) await inspectCache(child);
          else dependencyHashes.push(relative(cache, child).split(sep).join("/") + "\0" + sha256(await regularBytes(child, 268435456)));
        }
      };
      await inspectCache(cache);
      const simpleName = "AgentRegression" + randomUUID().replace(/-/g, "") + "Test";
      const packageName = sources[1].text.replace(/\/\*[\s\S]*?\*\//g, "").match(/^\s*package\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*;/m)?.[1] ?? "";
      const context = {baseCommit, imageId, dependencySnapshotHash: sha256(dependencyHashes.sort().join("\n")), dependencySnapshotBytes: cacheBytes, testClass: (packageName ? packageName + "." : "") + simpleName,
        testPath: prefix + "src/test/java/" + (packageName ? packageName.replace(/\./g, "/") + "/" : "") + simpleName + ".java"};
      if (texts.has(context.testPath)) throw new Error("test-path-exists");
      const sandbox = new FixSandbox(directory, snapshot, project, targetDirectory, docker, cache, sources, context, options.signal);
      for (const [path, bytes] of texts) sandbox.expected.set(path, sha256(bytes));
      for (const source of sources.slice(1)) sandbox.original.set(source.path, source.text);
      return sandbox;
    } catch (error) {await rm(directory, {recursive: true, force: true}); throw error;}
  }
  async writeTest(source: string): Promise<void> {
    const name = this.context.testClass.split(".").at(-1)!;
    const expectedPackage = this.context.testClass.split(".").slice(0, -1).join(".");
    const actualPackage = source.replace(/\/\*[\s\S]*?\*\//g, "").match(/^\s*package\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*;/m)?.[1] ?? "";
    const valid = (this.context.profile === "node" || this.context.profile === "typescript") ? Boolean(source.trim()) : this.context.profile === "python"
      ? /^def test_[A-Za-z0-9_]+\s*\(/m.test(source)
      : actualPackage === expectedPackage && new RegExp("\\bpublic\\s+(?:final\\s+)?class\\s+" + name + "\\b").test(source);
    if (!valid || Buffer.byteLength(source, "utf8") > 8000) throw new Error("invalid-regression-source");
    const path = at(this.snapshot, this.context.testPath);
    await mkdir(dirname(path), {recursive: true});
    await writeFile(path, source, {flag: "wx", mode: 0o600});
    this.testSource = source; this.expected.set(this.context.testPath, sha256(source));
  }
  async applyFix(changes: SourceChange[]): Promise<void> {
    validateFixChanges(changes, this.original);
    for (const change of changes) {
      if (sha256(await regularText(at(this.snapshot, change.path), 2097152)) !== this.expected.get(change.path)) throw new Error("source-changed");
    }
    for (const change of changes) {
      await writeFile(at(this.snapshot, change.path), change.content);
      this.expected.set(change.path, sha256(change.content));
    }
    this.changes = changes;
  }
  async run(_stage: ProofStage, targetClass?: string): Promise<TestRun> {
    const started = Date.now();
    if (this.signal.aborted) return {exitCode: null, interrupted: true, durationMs: 0, cases: []};
    for (const [path, hash] of this.expected) {
      if (sha256(await regularBytes(at(this.snapshot, path), 2097152)) !== hash) throw new Error("snapshot-changed");
    }
    await rm(this.targetDirectory, {recursive: true, force: true});
    await mkdir(this.targetDirectory, {mode: 0o700});
    const prefix = this.project ? this.project + "/" : "";
    const targetMount = at(this.snapshot, prefix + "target");
    if (this.cache) await mkdir(targetMount, {recursive: true});
    const name = "ai-privacy-fix-" + randomUUID();
    const args = dockerCreateArgs({profile: this.context.profile, snapshot: this.snapshot, target: this.targetDirectory, cache: this.cache,
      project: this.project, image: this.context.imageId, uid: process.getuid!(), gid: process.getgid!(), name}, targetClass);
    let created = false, interrupted = true, exitCode: number | null = null;
    try {
      await command("docker", [...this.docker, ...args], this.directory); created = true;
      interrupted = await attach([...this.docker, "start", "--attach", name], this.directory, 120000, this.signal);
      const state = JSON.parse((await command("docker", [...this.docker, "inspect", "--format", "{{json .State}}", name], this.directory)).toString("utf8"));
      if (!state.Running && state.Status === "exited" && !state.OOMKilled && Number.isInteger(state.ExitCode)) exitCode = state.ExitCode;
      else interrupted = true;
    } finally {
      try {await command("docker", [...this.docker, "rm", "--force", "--volumes", name], this.directory);}
      catch {if (created) {this.unsafeCleanup = true; throw new Error("sandbox-cleanup-failed");}}
    }
    const cases: TestCase[] = [];
    if (!interrupted) {
      const reports = join(this.targetDirectory, "surefire-reports");
      try {
        if (this.context.profile === "node" || this.context.profile === "typescript") {
          cases.push(...parseNodeReport(await regularText(join(this.targetDirectory, "node.xml"), 1048576)));
          return {exitCode, interrupted, durationMs: Date.now() - started, cases};
        }
        if (this.context.profile === "python") {
          cases.push(...parsePytestReport(await regularText(join(this.targetDirectory, "pytest.xml"), 1048576)));
          return {exitCode, interrupted, durationMs: Date.now() - started, cases};
        }
        const info = await lstat(reports);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("invalid-reports");
        const names = (await readdir(reports)).filter(n => /^TEST-[A-Za-z0-9_.$-]+\.xml$/.test(n));
        if (names.length > 512) throw new Error("too-many-reports");
        for (const name of names) cases.push(...parseSurefire(await regularText(join(reports, name), 1048576)));
      } catch {return {exitCode, interrupted: true, durationMs: Date.now() - started, cases: []};}
    }
    return {exitCode, interrupted, durationMs: Date.now() - started, cases};
  }
  async save(receipt: FixProofReceipt): Promise<string> {
    let patchHash: string | undefined;
    if (receipt.status === "verified") {
      if (!this.testSource || !this.changes.length || receipt.testHash !== sha256(this.testSource)) throw new Error("proof-artifact-mismatch");
      const patch = makePatch([{path: this.context.testPath, before: "", after: this.testSource, added: true},
        ...this.changes.map(c => ({path: c.path, before: this.original.get(c.path)!, after: c.content, added: false}))]);
      await writeFile(join(this.directory, "verified.patch"), patch, {flag: "wx", mode: 0o600});
      patchHash = sha256(patch);
    }
    if (this.testSource) await writeFile(join(this.directory, "proposed-regression." + ((this.context.profile === "node" || this.context.profile === "typescript") ? "cjs" : this.context.profile === "python" ? "py" : "java")), this.testSource, {flag: "wx", mode: 0o600});
    // Write the completion marker last, after its content-addressed artifact exists.
    await writeFile(join(this.directory, "receipt.json"), JSON.stringify({...receipt, patchHash,
      cleanupRequiresAttention: this.unsafeCleanup}, null, 2) + "\n", {flag: "wx", mode: 0o600});
    return this.directory;
  }
  async dispose(): Promise<void> {
    if (this.unsafeCleanup) return; // Preserve mounts if Docker cleanup could not be confirmed.
    await rm(this.snapshot, {recursive: true, force: true});
    await rm(this.targetDirectory, {recursive: true, force: true});
    if (this.cache) await rm(this.cache, {recursive: true, force: true});
    await rm(join(this.directory, "docker-config"), {recursive: true, force: true});
  }
}
export function makePatch(files: {path: string; before: string; after: string; added: boolean}[]): string {
  const output: string[] = [];
  for (const file of files) {
    safeRelative(file.path);
    const lines = (text: string): string[] => text ? text.replace(/\n$/, "").split("\n") : [];
    const old = lines(file.before), next = lines(file.after);
    output.push("diff --git " + JSON.stringify("a/" + file.path) + " " + JSON.stringify("b/" + file.path));
    if (file.added) output.push("new file mode 100644");
    output.push("--- " + (file.added ? "/dev/null" : JSON.stringify("a/" + file.path)), "+++ " + JSON.stringify("b/" + file.path));
    output.push("@@ -" + (old.length ? "1," + old.length : "0,0") + " +" + (next.length ? "1," + next.length : "0,0") + " @@");
    old.forEach((line, index) => {output.push("-" + line); if (index === old.length - 1 && !file.before.endsWith("\n")) output.push("\\ No newline at end of file");});
    next.forEach((line, index) => {output.push("+" + line); if (index === next.length - 1 && !file.after.endsWith("\n")) output.push("\\ No newline at end of file");});
  }
  return output.join("\n") + "\n";
}

export function validateFixChanges(changes: SourceChange[], originals: ReadonlyMap<string, string>): void {
  if (!changes.length || changes.length > 6 || new Set(changes.map(c => c.path)).size !== changes.length ||
    Buffer.byteLength(JSON.stringify(changes), "utf8") > 20000) throw new Error("invalid-change-set");
  for (const change of changes) {
    safeRelative(change.path);
    if (!originals.has(change.path) || !change.content.trim() || change.content === originals.get(change.path)) {
      throw new Error("fix-outside-approved-production-sources");
    }
  }
}
