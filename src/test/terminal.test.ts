import {test} from "node:test";
import {strict as assert} from "node:assert";
import {execFile, spawn} from "node:child_process";
import {createServer, Server} from "node:http";
import {AddressInfo} from "node:net";
import {mkdtemp, readFile, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {chooseModel, completeCommand, diffLines, mentionedFiles, parseLine, replaceLines} from "../terminal/helpers";
import {onPath, profileFile, shimPath, shimScript, writeShim} from "../terminal/shim";

const ROOT = join(__dirname, "..", "..");
const REPL = join(ROOT, "dist", "terminal", "repl.js");
const GB = 1024 ** 3;

test("terminal lines: slash commands with aliases, chat text, and Tab completion", () => {
  assert.deepEqual(parseLine("  /fix 2 "), {command: "fix", rest: "2"});
  assert.deepEqual(parseLine("/quit"), {command: "exit", rest: ""});
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
async function fakeOllama(): Promise<{server: Server; endpoint: string; prompts: string[]}> {
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
      if (request.stream) return res.end(JSON.stringify({response: "Local "}) + "\n" + JSON.stringify({response: "answer.", done: true}) + "\n");
      if (request.prompt.includes("Apply ONE minimal fix")) {
        const excerpt = request.prompt.slice(request.prompt.indexOf("\n", request.prompt.indexOf("FILE ")) + 1).split("\n").map(l => l.replace(/^\d+: /, ""));
        const replacement = excerpt.join("\n").replace('"SELECT * FROM books WHERE id = " + id,', '"SELECT * FROM books WHERE id = ?", [id],');
        return res.end(JSON.stringify({response: JSON.stringify({replacement})}));
      }
      if (request.prompt.includes("Change the code below exactly")) {
        const code = request.prompt.slice(request.prompt.indexOf("\n", request.prompt.indexOf("CODE ")) + 1);
        return res.end(JSON.stringify({response: JSON.stringify({content: code.replace("const app", "// Books API\nconst app"), summary: ["Added a header comment"]})}));
      }
      return res.end(JSON.stringify({response: JSON.stringify({findings: []})}));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return {server, endpoint: "http://127.0.0.1:" + (server.address() as AddressInfo).port, prompts};
}

const BOOKS = 'const express = require("express");\nconst app = express();\napp.get("/books", (req, res) => {\n  const id = req.query.id;\n' +
  '  db.query("SELECT * FROM books WHERE id = " + id, (err, rows) => res.json(rows));\n});\n';

function session(cwd: string, endpoint: string, input: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [REPL], {cwd, env: {...process.env, NO_COLOR: "1", HUSHAVYR_OLLAMA_ENDPOINT: endpoint, HUSHAVYR_MODEL: "fake-coder:1b", HUSHAVYR_CONFIG_DIR: join(cwd, ".config")}});
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
