import { test } from "node:test";
import { strict as assert } from "node:assert";
import type * as vscode from "vscode";
class Uri {
  constructor(readonly value: string, readonly scheme = "file") {}
  toString() { return this.value; }
}
class Location {}
class TabInputText {}
const disposable = {dispose() {}};
let handler: (request: any, context: any, stream: any, token: any) => Promise<unknown>;
let docs = new Map<string, string>();
const configuration: Record<string, unknown> = {};
const fake = {
  Uri, Location, TabInputText,
  window: {
    activeTextEditor: undefined, visibleTextEditors: [], tabGroups: {activeTabGroup: {}},
    onDidChangeActiveTextEditor: () => disposable, onDidChangeTextEditorSelection: () => disposable,
    showWarningMessage: async () => undefined, showErrorMessage: async () => undefined,
    showInformationMessage: async () => undefined
  },
  commands: {registerCommand: () => disposable},
  workspace: {
    isTrusted: true,
    getConfiguration: () => ({get: (key: string, fallback?: unknown) => configuration[key] ?? fallback}),
    openTextDocument: async (uri: Uri) => ({getText: () => docs.get(uri.toString()) ?? ""})
  },
  chat: {createChatParticipant: (_id: string, callback: typeof handler) => {handler = callback; return disposable;}}
};
// Load the extension against a small VS Code API double; no Electron or network needed.
const Module = require("node:module") as { _load: (name: string, ...args: any[]) => unknown };
const originalLoad = Module._load;
let activate: typeof import("../extension").activate;
try {
  Module._load = function(name, ...args) { return name === "vscode" ? fake : originalLoad.call(this, name, ...args); };
  activate = require("../extension").activate;
} finally { Module._load = originalLoad; }

async function chat(files: Record<string, string>, responses: string[], prompt = "check code for bugs", unknown = false) {
  docs = new Map(Object.entries(files));
  const requests: {url: string; payload?: any}[] = [];
  const output: string[] = [];
  const priorFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    requests.push({url, payload: init?.body ? JSON.parse(String(init.body)) : undefined});
    if (url.endsWith("/api/tags")) return new Response(JSON.stringify({models: [{name: "qwen2.5-coder:7b"}]}));
    const response = responses.shift();
    assert.equal(typeof response, "string", "unexpected model invocation");
    return new Response(JSON.stringify({response}));
  };
  try {
    activate({subscriptions: [], globalStorageUri: {fsPath: "/unused"}} as unknown as vscode.ExtensionContext);
    await handler({command: prompt === "Explain" ? undefined : "review", prompt,
      references: unknown ? [{value: "unreadable"}] : Object.keys(files).map(path => ({value: new Uri(path)}))}, {},
    {markdown: (text: string) => output.push(text)}, {isCancellationRequested: false, onCancellationRequested: () => disposable});
    return {requests, output: output.join('\n')};
  } finally {globalThis.fetch = priorFetch;}
}

test("Chat passes both attached files through review, line extraction and separate local verification", async () => {
  const result = await chat({"file:///Mapper.java": "String value = raw + input;", "file:///Input.java": "String input;"}, [
    JSON.stringify({findings: [{title: "JSON escaping", severity: "medium", path: "file:///Mapper.java", startLine: 1, endLine: 1,
      fix: "Use serializer", regressionTest: "Input with quote"}]}), '{"verdicts":[{"index":0,"supported":true}]}'
  ]);
  assert.equal(result.requests.length, 3); // inventory + reviewer + verifier
  assert.ok(result.requests.every(r => r.url.startsWith("http://127.0.0.1:11434/")));
  assert.match(result.requests[1].payload.prompt, /file:\/\/\/Input.java/);
  assert.match(result.requests[2].payload.prompt, /skeptical second reviewer/);
  assert.match(result.output, /String value = raw \+ input;/);
  assert.match(result.output, /Source support agreed/);
});
test("unreadable or oversized Chat context stops before any network request", async () => {
  const unknown = await chat({}, [], "review", true);
  assert.equal(unknown.requests.length, 0);
  assert.match(unknown.output, /cannot be inspected/);
  const large = await chat({"file:///Large.java": "x".repeat(21000)}, []);
  assert.equal(large.requests.length, 0);
  assert.match(large.output, /20 KB/);
});
test("normal Chat keeps the ordinary generation path", async () => {
  const result = await chat({}, ["Local explanation"], "Explain");
  assert.equal(result.requests.length, 2);
  assert.equal(result.requests[1].payload.format, undefined);
  assert.match(result.output, /Local explanation/);
});
