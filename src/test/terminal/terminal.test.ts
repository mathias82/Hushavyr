import {test} from "node:test";
import {strict as assert} from "node:assert";
import {execFile, spawn} from "node:child_process";
import {createServer, Server} from "node:http";
import {AddressInfo} from "node:net";
import {mkdir, mkdtemp, readFile, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {basename, join} from "node:path";
import {chooseModel, COMMANDS, completeCommand, cveDbHint, diffLines, mentionedFiles, movedLine, parseLine, replaceLines} from "../../terminal/helpers";
import {onPath, profileFile, shimPath, shimScript, writeShim} from "../../terminal/shim";
import {resolveCopilot} from "../../terminal/copilot";

const ROOT = join(__dirname, "..", "..", "..");
const REPL = join(ROOT, "dist", "terminal", "repl.js");
const GB = 1024 ** 3;

test("dependency scans without an offline CVE database point to /update-db", () => {
  assert.match(cveDbHint(["trivy: failed (0 vulnerabilities)", "osv-scanner: ok (0 additional vulnerabilities)"]) ?? "", /\/update-db/);
  assert.match(cveDbHint(["semgrep: 2 findings", "trivy: ok (0 vulnerabilities)", "osv-scanner: no offline database (0 additional vulnerabilities)"]) ?? "", /\/update-db/);
  assert.equal(cveDbHint(["trivy: ok (3 vulnerabilities)", "osv-scanner: ok (0 additional vulnerabilities)"]), undefined);
});

test("terminal lines: slash commands with aliases, chat text, and Tab completion", () => {
  assert.deepEqual(parseLine("  /fix 2 "), {command: "fix", rest: "2"});
  assert.deepEqual(parseLine("/quit"), {command: "exit", rest: ""});
  assert.deepEqual(parseLine(" exit "), {command: "exit", rest: ""});
  assert.deepEqual(parseLine("Quit"), {command: "exit", rest: ""});
  assert.deepEqual(parseLine("exit the loop early in OrderService"), {rest: "exit the loop early in OrderService"});
  assert.deepEqual(parseLine("/deps ./api"), {command: "dependencies", rest: "./api"});
  assert.deepEqual(parseLine("what does src/app.ts do?"), {rest: "what does src/app.ts do?"});
  assert.deepEqual(completeCommand("/se"), ["/security", "/secrets", "/setup"]);
  assert.deepEqual(completeCommand("hello /se"), []);
});

test("terminal model: the configured one, else the machine's best if downloaded, else a downloaded code model", () => {
  assert.equal(chooseModel("codestral:22b", ["qwen2.5-coder:7b"], 32 * GB), "codestral:22b");
  assert.equal(chooseModel(undefined, ["qwen3-coder:30b"], 32 * GB), "qwen3-coder:30b");
  assert.equal(chooseModel(undefined, ["llama3:8b", "qwen2.5-coder:7b"], 32 * GB), "qwen2.5-coder:7b");
  assert.equal(chooseModel(undefined, [], 16 * GB), "qwen2.5-coder:7b");
});

test("terminal chat includes only mentioned files that exist; diffs and replacements keep line numbers and endings", () => {
  const files = new Set(["src/app.ts", "pom.xml"]);
  assert.deepEqual(mentionedFiles("compare src/app.ts with @pom.xml and missing.ts, then src/app.ts again", p => files.has(p)), ["src/app.ts", "pom.xml"]);
  assert.deepEqual(diffLines("a\nb\nc", "a\nB\nc", 10), [{kind: "-", line: 11, text: "b"}, {kind: "+", line: 11, text: "B"}]);
  assert.equal(replaceLines("one\r\ntwo\r\nthree\r\n", 1, 1, "2a\n2b"), "one\r\n2a\r\n2b\r\nthree\r\n");
});

test("global hushavyr launcher: per-platform location, PATH check, shell profile, and it never overwrites a foreign file", async () => {
  assert.equal(shimPath("darwin", "/Users/me", {}), "/Users/me/.local/bin/hushavyr");
  assert.match(shimPath("win32", "C:\\Users\\me", {LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local"}), /WindowsApps[\\/]hushavyr\.cmd$/);
  assert.ok(onPath("/Users/me/.local/bin", "/usr/bin:/Users/me/.local/bin/", "darwin"));
  assert.ok(!onPath("/Users/me/.local/bin", "/usr/bin", "darwin"));
  assert.ok(onPath("C:\\Tools", "c:\\tools;C:\\Windows", "win32"));
  assert.equal(profileFile("/bin/zsh", "darwin", "/h"), "/h/.zshrc");
  assert.equal(profileFile("/bin/bash", "linux", "/h"), "/h/.bashrc");
  assert.match(shimScript("darwin", "/ext/it's", "/Apps/Code Helper"), /launcher='\/ext\/it'\\''s\/bin\/hushavyr'/);
  assert.match(shimScript("win32", "C:\\ext", "C:\\Code.exe"), /call "C:\\ext\\bin\\hushavyr\.cmd" %\*/);
  const dir = await mkdtemp(join(tmpdir(), "hushavyr-shim-"));
  const foreign = join(dir, "hushavyr");
  await writeFile(foreign, "#!/bin/sh\necho mine\n");
  assert.equal(await writeShim(foreign, shimScript("darwin", ROOT, process.execPath)), false);
  assert.equal(await readFile(foreign, "utf8"), "#!/bin/sh\necho mine\n");
});

test("the installed launcher runs the bundled terminal from any folder", {skip: process.platform === "win32"}, async () => {
  const dir = await mkdtemp(join(tmpdir(), "hushavyr-shim-"));
  const shim = join(dir, "bin", "hushavyr");
  assert.ok(await writeShim(shim, shimScript(process.platform, ROOT, process.execPath)));
  const version = (JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")) as {version: string}).version;
  const stdout = await new Promise<string>((resolve, reject) => execFile(shim, ["--version"], {cwd: dir}, (error, out) => error ? reject(error) : resolve(out)));
  assert.equal(stdout.trim(), version);
});

/** A loopback stand-in for Ollama: one installed model, streamed chat answers and JSON fixes/edits built from the prompt. */
async function fakeOllama(partialFix = false): Promise<{server: Server; endpoint: string; prompts: string[]}> {
  const prompts: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/api/tags") return res.end(JSON.stringify({models: [{name: "fake-coder:1b"}]}));
      if (req.url === "/api/show") return res.end(JSON.stringify({model_info: {"general.architecture": "qwen2"}}));
      const request = JSON.parse(body || "{}") as {prompt: string; stream?: boolean};
      prompts.push(request.prompt);
      if (request.stream) return res.end(JSON.stringify({response: request.prompt.includes("are you sure") ? "I'm not sure without more context. " : "Local "}) + "\n" + JSON.stringify({response: "answer.", done: true}) + "\n");
      if (request.prompt.includes("You write the git commit message")) {
        return res.end(JSON.stringify({response: JSON.stringify({commit: "fix(books): use a parameterized query", title: "Use a parameterized query for book lookup",
          body: "## What\n- Bind the id parameter\n\n## Why\nNot stated in the diff.\n\n## Tests\nNo test changes in this diff."})}));
      }
      if (request.prompt.includes("skeptical second reviewer")) {
        const candidates = JSON.parse(request.prompt.slice(request.prompt.indexOf("UNTRUSTED CANDIDATES:\n") + 22)) as unknown[];
        return res.end(JSON.stringify({response: JSON.stringify({verdicts: candidates.map((_, index) => ({index, supported: true}))})}));
      }
      if (request.prompt.includes("Apply ONE minimal fix") && partialFix) {
        // Like qwen2.5-coder:14b on a multi-statement fix: only the changed statements, which cannot be placed safely.
        return res.end(JSON.stringify({response: JSON.stringify({replacement: "\n  const sql = \"SELECT * FROM books WHERE id = ?\";\n  const params = [id];\n  db.query(sql, params, (err, rows) => res.json(rows));\n"})}));
      }
      if (request.prompt.includes("Fix only this finding")) {
        const code = request.prompt.slice(request.prompt.indexOf("\n", request.prompt.indexOf("CODE ")) + 1);
        return res.end(JSON.stringify({response: JSON.stringify({content: code.replace('"SELECT * FROM books WHERE id = " + id,', '"SELECT * FROM books WHERE id = ?", [id],'), summary: ["Bound id"]})}));
      }
      if (request.prompt.includes("Apply ONE minimal fix")) {
        const excerpt = request.prompt.slice(request.prompt.indexOf("\n", request.prompt.indexOf("FILE ")) + 1).split("\n").map(l => l.replace(/^\d+: /, ""));
        const replacement = excerpt.join("\n").replace('"SELECT * FROM books WHERE id = " + id,', '"SELECT * FROM books WHERE id = ?", [id],');
        return res.end(JSON.stringify({response: JSON.stringify({replacement})}));
      }
      if (request.prompt.includes("Change the code below exactly")) {
        const code = request.prompt.slice(request.prompt.indexOf("\n", request.prompt.indexOf("CODE ")) + 1);
        const content = code.includes("const app") ? code.replace("const app", "// Books API\nconst app") : "// edited\n" + code.trimStart();
        return res.end(JSON.stringify({response: JSON.stringify({content, summary: ["Added a header comment"]})}));
      }
      return res.end(JSON.stringify({response: JSON.stringify({findings: []})}));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return {server, endpoint: "http://127.0.0.1:" + (server.address() as AddressInfo).port, prompts};
}

const BOOKS = 'const express = require("express");\nconst app = express();\napp.get("/books", (req, res) => {\n  const id = req.query.id;\n' +
  '  db.query("SELECT * FROM books WHERE id = " + id, (err, rows) => res.json(rows));\n});\n';

function session(cwd: string, endpoint: string, input: string[], env: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [REPL], {cwd, env: {...process.env, NO_COLOR: "1", HUSHAVYR_OLLAMA_ENDPOINT: endpoint, HUSHAVYR_MODEL: "fake-coder:1b", HUSHAVYR_CONFIG_DIR: join(cwd, ".config"), ...env}});
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    child.on("error", reject);
    child.on("exit", () => resolve(output));
    child.stdin.end(input.join("\n") + "\n");
  });
}

test("hushavyr session: chat with a mentioned file, scan, fix behind an approved diff, undo, decline, edit and explain", async () => {
  const {server, endpoint, prompts} = await fakeOllama();
  try {
    const dir = await mkdtemp(join(tmpdir(), "hushavyr-repl-"));
    const file = join(dir, "books.js");
    await writeFile(file, BOOKS);
    const output = await session(dir, endpoint, ["what does books.js do?", "/security", "/fix 2", "y", "/undo", "/fix 2", "n", "/edit books.js add a header comment", "y", "/explain 1", "/review books.js", "/model", "/exit"]);
    assert.match(output, /Model: {2}fake-coder:1b \(ready\)/);
    assert.match(output, /Including books\.js[\s\S]*Local answer\./);
    assert.ok(prompts[0].includes("SELECT * FROM books"), "chat prompt carries the mentioned file");
    assert.match(output, /\[2\] HIGH {3}books\.js:5 {2}SQL injection/);
    assert.match(output, /- {4}5 │ {3}db\.query\("SELECT \* FROM books WHERE id = " \+ id,[\s\S]*\+ {4}5 │ {3}db\.query\("SELECT \* FROM books WHERE id = \?", \[id\],/);
    assert.match(output, /Apply this fix\? \[y\/N\] y\nApplied to books\.js\./);
    assert.match(output, /Restored books\.js\./);
    assert.match(output, /Apply this fix\? \[y\/N\] n\nDiscarded\. books\.js is unchanged\./);
    assert.match(output, /• Added a header comment[\s\S]*Applied to books\.js\./);
    assert.equal(await readFile(file, "utf8"), BOOKS.replace("const app", "// Books API\nconst app"));
    assert.ok(prompts.some(p => p.includes("A deterministic security scanner reported this finding")), "/explain N explains the finding");
    assert.match(output, /Reviewing books\.js with fake-coder:1b[\s\S]*\[1\] HIGH {3}books\.js:\d+ {2}Local rule: SQL [\s\S]*Fix: /);
    assert.match(output, /Current model: fake-coder:1b\nInstalled: fake-coder:1b/);
  } finally { server.close(); }
});

test("finding lines follow a change above them; findings in the rewritten lines have no line", () => {
  const before = "a\nb\nc\nd\ne", after = "a\nB1\nB2\nc\nd\ne";
  assert.deepEqual([1, 2, 3, 4, 5].map(l => movedLine(before, after, l)), [1, undefined, 4, 5, 6]);
  assert.equal(movedLine(before, before, 3), 3);
});

test("/fix rewrites the enclosing function when the few-line fix does not fit", async () => {
  const {server, endpoint, prompts} = await fakeOllama(true);
  try {
    const dir = await mkdtemp(join(tmpdir(), "hushavyr-repl-"));
    const file = join(dir, "books.js");
    const source = 'const express = require("express");\nconst app = express();\nfunction findBook(req, res) {\n  const id = req.query.id;\n' +
      '  db.query("SELECT * FROM books WHERE id = " + id, (err, rows) => res.json(rows));\n}\napp.get("/books", findBook);\n';
    await writeFile(file, source);
    const output = await session(dir, endpoint, ["/security", "/fix 1", "y", "/fix 1", "/undo", "/fix 1", "n", "/exit"]);
    assert.match(output, /The code of finding 1 changed after the scan[\s\S]*Restored books\.js\.[\s\S]*Apply this fix\? \[y\/N\] n/);
    assert.ok(prompts.some(p => p.includes("Fix only this finding at file line 5")), output);
    assert.match(output, /- {4}5 │ {3}db\.query\("SELECT \* FROM books WHERE id = " \+ id,[\s\S]*\+ {4}5 │ {3}db\.query\("SELECT \* FROM books WHERE id = \?", \[id\],/);
    assert.equal(await readFile(file, "utf8"), source);
  } finally { server.close(); }
});

test("hushavyr without Ollama: scans still work and AI commands say how to set up, with no file change", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hushavyr-repl-"));
  await writeFile(join(dir, "books.js"), BOOKS);
  const output = await session(dir, "http://127.0.0.1:9", ["/secrets", "/security", "/fix 1", "hello", "/nope"]);
  assert.match(output, /Ollama is not running: type \/setup/);
  assert.match(output, /No findings\./);
  assert.match(output, /SQL injection/);
  assert.match(output, /Error: Ollama is not running\. Type \/setup/);
  assert.match(output, /Unknown command \/nope/);
  assert.equal(await readFile(join(dir, "books.js"), "utf8"), BOOKS);
});

test("hushavyr /update-db: auto on is saved, and missing scanners are reported instead of failing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hushavyr-repl-"));
  const output = await session(dir, "http://127.0.0.1:9", ["/update-db auto on", "/update-db"], {PATH: join(dir, "no-tools")});
  assert.match(output, /CVE databases will update before \/scan and \/dependencies/);
  assert.equal((JSON.parse(await readFile(join(dir, ".config", "config.json"), "utf8")) as {autoUpdateVulnDb?: boolean}).autoUpdateVulnDb, true);
  assert.match(output, /Neither Trivy nor OSV-Scanner is installed: type \/setup\./);
});

test("hushavyr: /review of a folder or 'all' scans it, the folder's own name means this folder, and chat knows the folder and commands", async () => {
  const {server, endpoint, prompts} = await fakeOllama();
  try {
    const dir = await mkdtemp(join(tmpdir(), "hushavyr-repl-"));
    await writeFile(join(dir, "books.js"), BOOKS);
    const output = await session(dir, endpoint, ["/review all", "/security " + basename(dir), "review the folder for bugs"]);
    assert.match(output, /for a whole folder this runs \/scan[\s\S]*SQL injection/);
    assert.doesNotMatch(output, /is not a (?:file|folder)/);
    assert.ok(prompts.some(p => p.includes(JSON.stringify(basename(dir))) && p.includes("Whole folder for bugs and security issues: /scan")), "chat prompt names the folder and the commands");
  } finally { server.close(); }
});

const ORDERS = "package shop;\n\npublic class OrderService {\n  public double total(double price, int qty) {\n    return price * qty;\n  }\n\n" +
  "  public void place(String email) {\n    System.out.println(email);\n  }\n}\n";

test("hushavyr finds code by name with typos, edits only that method, describes only the folder it runs in, and asks once about meaning search", async () => {
  const {server, endpoint, prompts} = await fakeOllama();
  try {
    const parent = await mkdtemp(join(tmpdir(), "hushavyr-repl-"));
    const dir = join(parent, "shop");
    await mkdir(join(dir, "src", "shop"), {recursive: true});
    await writeFile(join(parent, "Outside.java"), "class OutsideSecret { void leak() {} }\n");
    await writeFile(join(dir, "README.md"), "# Shop\nOrders and confirmation mails.\n");
    await writeFile(join(dir, "src", "shop", "OrderService.java"), ORDERS);
    const output = await session(dir, endpoint, ["describe the project", "/find order servce", "where is the confirmation mail written?", "n",
      "/find OutsideSecret", "where else do we mail?", "/edit OrderServce.place add a header comment", "y", "exit"]);
    assert.ok(prompts.some(p => p.includes("PROJECT OVERVIEW") && p.includes("Orders and confirmation mails") && p.includes("OrderService")), "overview reaches the model");
    assert.ok(!prompts.some(p => p.includes("void leak()") || p.includes("Outside.java")), "nothing outside the start folder is read");
    assert.match(output, /\[1\] OrderService {2}src\/shop\/OrderService\.java:3-11/);
    assert.doesNotMatch(output, /\] OutsideSecret/);
    assert.match(output, /Using OrderService\.place\(\) {2}src\/shop\/OrderService\.java:8-10/);
    assert.equal(await readFile(join(dir, "src", "shop", "OrderService.java"), "utf8"), ORDERS.replace("  public void place", "  // edited\n  public void place"));
    assert.equal(output.match(/Search your code by meaning\?/g)?.length, 1);
    assert.equal((JSON.parse(await readFile(join(dir, ".config", "config.json"), "utf8")) as {searchByMeaning?: boolean}).searchByMeaning, false);
  } finally { server.close(); }
});

test("hushavyr /dismiss hides a finding for the team, also in later scans", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hushavyr-repl-"));
  await mkdir(join(dir, ".git"));
  await writeFile(join(dir, "books.js"), BOOKS);
  const output = await session(dir, "http://127.0.0.1:9", ["/security", "/dismiss 2 test fixture", "/security"]);
  assert.match(output, /Dismissed: SQL injection/);
  const saved = JSON.parse(await readFile(join(dir, ".hushavyr", "dismissed.json"), "utf8")) as {dismissed: {path: string; reason: string}[]};
  assert.deepEqual(saved.dismissed.map(d => [d.path, d.reason]), [["books.js", "test fixture"]]);
  const after = output.slice(output.lastIndexOf("Security scan"));
  assert.match(after, /\d finding\(s\) hidden: dismissed by the team/);
  assert.doesNotMatch(after, /SQL injection/);
});

test("hushavyr /escalate is off by default, shows the exact pseudonymized text and sends it only after approval; /pr and /prove refuse safely", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hushavyr-repl-"));
  await writeFile(join(dir, "books.js"), BOOKS);
  const fake = join(dir, "fake-copilot.js"), sent = join(dir, "sent.txt");
  await writeFile(fake, "require('fs').writeFileSync(" + JSON.stringify(sent) + ", process.argv[3]); console.log('Use a parameterized query.');\n");
  const output = await session(dir, "http://127.0.0.1:9", ["/escalate books.js:5", "/escalate on", "/escalate books.js:3-5 is this safe?", "n",
    "/escalate books.js:3-5 is this safe?", "y", "/pr", "/prove books.js returns all books", "/escalate off"], {HUSHAVYR_COPILOT: fake});
  assert.match(output, /Nothing was sent: cloud escalation is off/);
  assert.match(output, /Exact text to send to GitHub Copilot[\s\S]*id5\.query\("s2" \+ id4[\s\S]*Send exactly this text\? \[y\/N\] n\nNothing was sent/);
  assert.match(output, /Cloud answer[\s\S]*Use a parameterized query\./);
  const payload = await readFile(sent, "utf8");
  assert.ok(payload.includes("is this safe?") && !payload.includes("const express") && !payload.includes("SELECT"), "only the approved lines are sent, pseudonymized");
  assert.match(output, /not a git repository\. Nothing was pushed\./);
  assert.match(output, /No project file/);
  assert.match(output, /Cloud escalation is off\./);
  assert.equal(await readFile(join(dir, "books.js"), "utf8"), BOOKS);
});

test("Copilot CLI runs without a shell: winget copilot.exe directly, the npm .cmd shim through its JavaScript entry, never a .cmd", () => {
  const files = new Set(["C:\\winget\\copilot.exe", "C:\\npm\\copilot.cmd", "C:\\npm\\node_modules\\@github\\copilot\\npm-loader.js"].map(f => f.replace(/\\/g, "/")));
  const exists = (f: string) => files.has(f.replace(/\\/g, "/"));
  assert.equal(resolveCopilot(undefined, "win32", "C:/winget;C:/npm", exists, "node")?.file.replace(/\\/g, "/"), "C:/winget/copilot.exe");
  const npm = resolveCopilot(undefined, "win32", "C:/npm", exists, "node");
  assert.equal(npm?.file, "node");
  assert.equal(npm?.args[0].replace(/\\/g, "/"), "C:/npm/node_modules/@github/copilot/npm-loader.js");
  assert.equal(resolveCopilot(undefined, "win32", "C:/empty", exists, "node"), undefined);
  assert.equal(resolveCopilot("C:/x/copilot.cmd", "win32", "", exists, "node"), undefined);
  assert.deepEqual(resolveCopilot(undefined, "darwin", "/usr/bin", exists, "node"), {file: "copilot", args: []});
});

test("hushavyr offers /escalate only when the local model is unsure, asks first, and /escalate suggest off stops it", async () => {
  const {server, endpoint} = await fakeOllama();
  try {
    const dir = await mkdtemp(join(tmpdir(), "hushavyr-repl-"));
    await writeFile(join(dir, "books.js"), BOOKS);
    const fake = join(dir, "fake-copilot.js"), sent = join(dir, "sent.txt");
    await writeFile(fake, "require('fs').writeFileSync(" + JSON.stringify(sent) + ", process.argv[3]); console.log('Copilot says hi.');\n");
    const output = await session(dir, endpoint, ["what does books.js do?", "are you sure?", "are you sure about books.js?", "n", "are you sure about books.js?", "y", "y",
      "/escalate suggest off", "are you sure about books.js?"], {HUSHAVYR_COPILOT: fake});
    const [first, ...rest] = output.split("The local model may be wrong here");
    assert.doesNotMatch(first, /Turn on \/escalate/, "a confident answer offers nothing");
    assert.equal(rest.length, 2, "suggested twice: not without a file, not after suggest off");
    assert.match(rest[0], /you doubted the previous answer[\s\S]*Turn on \/escalate and ask GitHub Copilot about books\.js:1-\d+\? .*\[y\/N\] n/);
    assert.match(rest[1], /Exact text to send to GitHub Copilot[\s\S]*Send exactly this text\? \[y\/N\] y[\s\S]*Copilot says hi\.[\s\S]*No more \/escalate suggestions\./);
    assert.ok(!(await readFile(sent, "utf8")).includes("SELECT"), "sent pseudonymized");
    const config = JSON.parse(await readFile(join(dir, ".config", "config.json"), "utf8")) as {cloudEscalation?: boolean; suggestEscalation?: boolean};
    assert.deepEqual([config.cloudEscalation, config.suggestEscalation], [true, false]);
  } finally { server.close(); }
});

test("hushavyr /pr without a title: the local model writes the commit message and PR text from the diff; edit and cancel commit nothing, y commits with it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hushavyr-pr-"));
  const git = (...args: string[]) => new Promise<string>((resolve, reject) => execFile("git", args, {cwd: dir}, (error, out) => error ? reject(error) : resolve(out)));
  await git("init", "-q", "-b", "main");
  await git("config", "user.email", "t@example.com");
  await git("config", "user.name", "T");
  await writeFile(join(dir, "books.js"), BOOKS);
  await writeFile(join(dir, "OrderService.java"), "class OrderService {\n  OrderService() {}\n  OrderService(int n) {}\n  void place() {}\n}\n");
  await git("add", "-A");
  await git("commit", "-qm", "init");
  await git("init", "-q", "--bare", join(dir, "..", "origin-" + dir.split(/[\\/]/).pop() + ".git"));
  await git("remote", "add", "origin", join(dir, "..", "origin-" + dir.split(/[\\/]/).pop() + ".git"));
  await writeFile(join(dir, "books.js"), BOOKS.replace('" + id,', '?", [id],'));
  const {server, endpoint, prompts} = await fakeOllama();
  try {
    const output = await session(dir, endpoint, ["/pr", "/explain OrderService", "/pr", "e", "fix(api): bind the book id", "", "n", "/pr", "y"], {GH_PROMPT_DISABLED: "1", HUSHAVYR_CONFIG_DIR: join(tmpdir(), "hushavyr-pr-cfg-" + Date.now())});
    const prompt = prompts.find(p => p.includes("You write the git commit message")) ?? "";
    assert.match(prompt, /\+\s+db\.query\("SELECT \* FROM books WHERE id = \?", \[id\]/, "the diff is in the local prompt");
    assert.match(output, /Commit: fix\(books\): use a parameterized query\nTitle:  Use a parameterized query for book lookup\n## What/);
    assert.match(output, /Commit: fix\(api\): bind the book id\nTitle:  Use a parameterized query for book lookup/);
    assert.match(output, /\(not answered: \/explain runs next\)\nCancelled\. Nothing was committed or pushed\.\nUsing OrderService  OrderService\.java:1-5/, "a command typed at a prompt runs; a class wins over its own constructors");
    assert.doesNotMatch(output, /Which one\?/);
    assert.equal((await git("log", "--all", "--format=%s")).trim().split("\n").length, 2, "one commit after y, none after cancel");
    assert.equal((await git("log", "-1", "--format=%s")).trim(), "fix(books): use a parameterized query");
    assert.match(output, /Pushed branch hushavyr\/use-a-parameterized-query-for-book-|Pull request opened/);
  } finally { server.close(); }
});

test("hushavyr /commit makes the first commit of a new repository with the local model's message and pushes nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hushavyr-commit-"));
  const git = (...args: string[]) => new Promise<string>((resolve, reject) => execFile("git", args, {cwd: dir}, (error, out) => error ? reject(error) : resolve(out)));
  await git("init", "-q", "-b", "main");
  await git("config", "user.email", "t@example.com");
  await git("config", "user.name", "T");
  await writeFile(join(dir, "books.js"), BOOKS);
  const {server, endpoint} = await fakeOllama();
  try {
    const output = await session(dir, endpoint, ["/pr", "/commit", "n", "kane commit", "y"], {HUSHAVYR_CONFIG_DIR: join(tmpdir(), "hushavyr-commit-cfg-" + Date.now())});
    assert.match(output, /No `origin` remote is configured/);
    assert.match(output, /Cancelled\. Nothing was committed\./);
    assert.match(output, /Committed on main: fix\(books\): use a parameterized query/);
    assert.equal((await git("log", "--format=%s")).trim(), "fix(books): use a parameterized query");
  } finally { server.close(); }
});

test("hushavyr /pr in a new repository pushes an empty base and opens the pull request from a new branch; /commit, /push, /gitcommits and /branch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hushavyr-push-"));
  const origin = dir + "-origin.git";
  const git = (...args: string[]) => new Promise<string>((resolve, reject) => execFile("git", args, {cwd: dir}, (error, out) => error ? reject(error) : resolve(out)));
  const remoteLog = async (ref: string) => (await git("--git-dir=" + origin, "log", ref, "--format=%s")).trim().split("\n");
  await git("init", "-q", "-b", "main");
  await git("config", "user.email", "t@example.com");
  await git("config", "user.name", "T");
  await git("init", "-q", "--bare", origin);
  await git("remote", "add", "origin", origin);
  await writeFile(join(dir, "books.js"), BOOKS);
  const {server, endpoint} = await fakeOllama();
  const env = () => ({GH_PROMPT_DISABLED: "1", HUSHAVYR_CONFIG_DIR: join(tmpdir(), "hushavyr-push-cfg-" + Date.now() + Math.random())});
  try {
    const first = await session(dir, endpoint, ["/pr", "y", "/gitcommits", "/push"], env());
    assert.match(first, /no commits yet: \/pr first pushes an empty "Initial commit" to main as the base branch/);
    assert.match(first, /Pushed branch hushavyr\/use-a-parameterized-query-for-book-|Pull request opened/);
    assert.deepEqual(await remoteLog("main"), ["Initial commit"], "main only has the empty base");
    const branch = (await git("branch", "--show-current")).trim();
    assert.match(branch, /^hushavyr\//);
    assert.deepEqual(await remoteLog(branch), ["fix(books): use a parameterized query", "Initial commit"]);
    assert.match(first, new RegExp("Commits on " + branch + " not on origin/main \\(1\\):\\n\\w+  \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d  T  fix\\(books\\): use a parameterized query"));

    await writeFile(join(dir, "books.js"), BOOKS.replace('" + id,', '?", [id],'));
    assert.match(first, /Nothing to push: hushavyr\/[^\n]* is up to date with origin\./);
    const second = await session(dir, endpoint, ["/branches", "/help branch", "/help nope", "/branch feature/x", "n", "/branch feature/x", "y", "/push", "/commit docs: second", "y", "/push", "y", "/branch main", "/branch bad..name"], env());
    assert.match(second, /Branches:\n {2}hushavyr\/[^\n]*\n {2}main|Branches:\n\* hushavyr\/[^\n]*\n {2}main/);
    assert.match(second, /Cancelled\. Still on the same branch\./);
    assert.match(second, /\/branch\n  \/branch \[name\][^\n]*\n      \/branch  list branches\n      \/branch feature\/login  switch, or create it \(asks first\)/, "/help <command> shows one command with its options");
    assert.match(second, /No command \/nope\. All commands:\nCommands\n[\s\S]*\/review diff  only the methods you changed[\s\S]*\/branches/);
    assert.match(second, /Created and switched to feature\/x\. Uncommitted changes came along\./);
    assert.match(second, /1 changed file is not committed and will not be pushed/);
    assert.match(second, /Committed on feature\/x: docs: second/);
    assert.match(second, /No new commits: pushing creates feature\/x on origin\.[\s\S]*Commits to push \(1, branch feature\/x\):\n\w+  docs: second\nPush feature\/x to origin\? \[y\/N\] y\nPushed feature\/x to origin\./);
    assert.match(second, /Switched to main\./);
    assert.match(second, /Invalid branch name: bad\.\.name/);
    assert.equal((await remoteLog("feature/x"))[0], "docs: second");
    assert.equal((await git("branch", "--show-current")).trim(), "main");
  } finally { server.close(); }
});

test("hushavyr /review diff sends only the changed methods (real line numbers) and new files whole; no changes sends nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hushavyr-diff-"));
  const git = (...args: string[]) => new Promise<string>((resolve, reject) => execFile("git", args, {cwd: dir}, (error, out) => error ? reject(error) : resolve(out)));
  await git("init", "-q", "-b", "main");
  await git("config", "user.email", "t@example.com");
  await git("config", "user.name", "T");
  const method = (name: string, body: string) => ["  int " + name + "(int a) {", ...Array.from({length: 8}, (_, i) => "    a += " + i + "; // " + name), "    " + body, "    return a;", "  }", ""];
  const original = ["class Calc {", ...method("first", "a *= 2;"), ...method("second", "a *= 3;"), ...method("third", "a *= 4;"), "}", ""].join("\n");
  await writeFile(join(dir, "Calc.java"), original);
  await git("add", "-A");
  await git("commit", "-qm", "init");
  const {server, endpoint, prompts} = await fakeOllama();
  try {
    const clean = await session(dir, endpoint, ["/review diff"], {HUSHAVYR_CONFIG_DIR: join(tmpdir(), "hushavyr-diff-cfg-" + Date.now())});
    assert.match(clean, /No uncommitted code changes/);
    assert.equal(prompts.length, 0, "nothing reaches the model without changes");
    await writeFile(join(dir, "Calc.java"), original.replace("a *= 3;", "a /= 0;"));
    await writeFile(join(dir, "Extra.java"), "class Extra {\n  int one() { return 1; }\n}\n");
    const output = await session(dir, endpoint, ["/review diff"], {HUSHAVYR_CONFIG_DIR: join(tmpdir(), "hushavyr-diff-cfg2-" + Date.now())});
    const review = prompts.filter(p => p.includes('SOURCE "Calc.java"'));
    assert.ok(review.length, "Calc.java was reviewed");
    assert.match(review[0], /\n15:   int second\(int a\) \{/, "the changed method keeps its real line numbers");
    assert.match(review[0], /a \/= 0;/);
    assert.doesNotMatch(review[0], /\/\/ first|\/\/ third/, "unchanged methods are not sent");
    assert.ok(prompts.some(p => p.includes('SOURCE "Extra.java"') && p.includes("1: class Extra {")), "a new file is reviewed whole");
    assert.match(output, /Reviewing Calc\.java \(15-26\)/);
    assert.match(output, /Reviewed \d+ changed line\(s\) of \d+ in 2 file\(s\) in \d+s\. Nothing left this machine\./);
  } finally { server.close(); }
});

test("every slash command exists in both the terminal and the VS Code chat", async () => {
  const pkg = JSON.parse(await readFile(join(__dirname, "..", "..", "..", "package.json"), "utf8"));
  const chat = new Set<string>(pkg.contributes.chatParticipants.flatMap((p: {commands: {name: string}[]}) => p.commands.map(c => c.name)));
  const terminal = new Set<string>(COMMANDS.map(c => c.name));
  // Terminal-only: leaving and clearing the prompt. Chat-only: /auto (plain text in the terminal).
  assert.deepEqual([...terminal].filter(n => !chat.has(n) && !["exit", "clear"].includes(n)), []);
  assert.deepEqual([...chat].filter(n => !terminal.has(n) && n !== "auto"), []);
});

test("hushavyr /scan-changed shows findings only in changed files; /review-changes and /scan-changed without changes do nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hushavyr-changed-"));
  const git = (...args: string[]) => new Promise<string>((resolve, reject) => execFile("git", args, {cwd: dir}, (error, out) => error ? reject(error) : resolve(out)));
  await git("init", "-q", "-b", "main");
  await git("config", "user.email", "t@example.com");
  await git("config", "user.name", "T");
  await writeFile(join(dir, "old.js"), BOOKS);
  await git("add", "-A");
  await git("commit", "-qm", "init");
  const env = () => ({HUSHAVYR_CONFIG_DIR: join(tmpdir(), "hushavyr-changed-cfg-" + Date.now())});
  const clean = await session(dir, "http://127.0.0.1:1", ["/scan-changed", "/review-changes"], env());
  assert.match(clean, /Nothing to scan/);
  assert.match(clean, /No uncommitted code changes/);
  await writeFile(join(dir, "new.js"), BOOKS);
  const output = await session(dir, "http://127.0.0.1:1", ["/scan-changed"], env());
  assert.match(output, /new\.js:5 {2}SQL injection/);
  assert.doesNotMatch(output, /old\.js:\d/);
});

test("hushavyr /test runs the project's tests only after y, says when there is no test setup; /improve needs a target", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hushavyr-test-"));
  const none = await session(dir, "http://127.0.0.1:1", ["/test", "/improve"]);
  assert.match(none, /No test setup found/);
  assert.match(none, /Name what to improve, for example: \/improve/);
  await writeFile(join(dir, "package.json"), JSON.stringify({scripts: {test: "node -e \"require('fs').writeFileSync('ran', '')\""}}));
  const declined = await session(dir, "http://127.0.0.1:1", ["/test", "n"]);
  assert.doesNotMatch(declined, /Running npm test/);
  await assert.rejects(readFile(join(dir, "ran")));
  const ran = await session(dir, "http://127.0.0.1:1", ["/test", "y"]);
  assert.match(ran, /Running npm test[\s\S]*passed/);
  await readFile(join(dir, "ran"));
});
