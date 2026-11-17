import {test} from "node:test";
import {strict as assert} from "node:assert";
import type * as vscode from "vscode";
const state = {
  documents: [] as any[], lookup: 0, messages: [] as any[], options: [] as any[], events: [] as any[],
  html: "", webviewOptions: {} as any, approval: true, failAudit: false
};
const disposable = {dispose() {}};
class Source {
  token = {isCancellationRequested: false, onCancellationRequested: () => disposable};
  cancel() {this.token.isCancellationRequested = true;}
  dispose() {}
}
const fake: any = {
  CancellationTokenSource: Source,
  LanguageModelChatMessage: {User: (content: string) => ({role: "user", content})},
  ViewColumn: {Active: 1},
  workspace: {
    isTrusted: true, workspaceFolders: undefined,
    get textDocuments() {return state.documents;},
    getConfiguration: (section: string) => ({get: (key: string, fallback: unknown) =>
      section === "aiPrivacyRouter" && key === "routingMode" ? "hybrid-public-prompts" : fallback})
  },
  lm: {selectChatModels: async (selector: any) => {
    state.lookup++; assert.deepEqual(selector, {vendor: "copilot"});
    return [{vendor: "copilot", id: "test/model", name: "Test model",
      sendRequest: async (messages: any[], options: any, _token: any) => {
        state.messages.push(messages); state.options.push(options);
        return {text: (async function* () {yield "public "; yield "answer";})()};
      }}];
  }},
  window: {
    showQuickPick: async (items: any[]) => items[0],
    showWarningMessage: async () => state.approval ? "This exact prompt is public — send" : undefined,
    createWebviewPanel: (_type: string, _title: string, _column: number, options: any) => {
      state.webviewOptions = options;
      return {
        webview: {set html(value: string) {state.html = value;}},
        onDidDispose: () => disposable, dispose() {}
      };
    }
  }
};
const Module = require("node:module") as {_load: (name: string, ...args: any[]) => any};
const original = Module._load;
let createAutoPrompt: typeof import("../autoPrompt").createAutoPrompt;
try {
  Module._load = function(name, ...args) {
    if (name === "vscode") return fake;
    if (name === "./audit") return {writeRetainedAuditEvent: async (_path: string, event: any) => {
      state.events.push(event); if (state.failAudit) throw new Error("disk full");
    }};
    return original.call(this, name, ...args);
  };
  createAutoPrompt = require("../autoPrompt").createAutoPrompt;
} finally {Module._load = original;}
function reset() {
  state.documents = []; state.lookup = 0; state.messages = []; state.options = [];
  state.events = []; state.html = ""; state.approval = true; state.failAudit = false;
}
function run(prompt: string) {
  const handler = createAutoPrompt({subscriptions: [], globalStorageUri: {fsPath: "/not-used"}} as unknown as vscode.ExtensionContext);
  return handler(prompt, new Source().token as vscode.CancellationToken);
}
test("Copilot adapter sends one approved message, no tools/history, with an inert escaped preview", async () => {
  reset();
  const result = await run("Design a Java queue and explain </pre><script>unsafe()</script>");
  assert.equal(result.provider, "copilot"); assert.equal(result.text, "public answer");
  assert.equal(state.messages.length, 1); assert.equal(state.messages[0].length, 1);
  assert.equal(state.messages[0][0].role, "user");
  assert.deepEqual(state.options, [{}]);
  assert.equal(state.webviewOptions.enableScripts, false);
  assert.equal(state.webviewOptions.enableCommandUris, false);
  assert.deepEqual(state.webviewOptions.localResourceRoots, []);
  assert.match(state.html, /&lt;script&gt;unsafe/);
  assert.doesNotMatch(state.html, /<script>unsafe/);
  assert.match(state.html, /default-src 'none'/);
  assert.deepEqual(state.events.map(e => e.outcome), ["approved", "attempted", "sent"]);
  assert.doesNotMatch(JSON.stringify(state.events), /Design a Java queue|unsafe/);
});
test("preview cancellation and audit failure prevent the Copilot send", async () => {
  reset(); state.approval = false;
  assert.equal((await run("Design a Java queue")).provider, "none");
  assert.equal(state.messages.length, 0);
  assert.equal(state.events[0].outcome, "cancelled");
  reset(); state.failAudit = true;
  await assert.rejects(run("Design a Java queue"));
  assert.equal(state.messages.length, 0);
});
test("open private document forces Ollama without reading or forwarding its contents", async () => {
  reset(); state.documents = [{uri: {scheme: "file"}, getText() {throw new Error("private content must not be read");}}];
  const prior = globalThis.fetch;
  const prompts: string[] = [];
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith("/api/show")) return new Response(JSON.stringify({model_info: {"general.architecture": "qwen2"}}));
    if (String(url).endsWith("/api/tags")) return new Response(JSON.stringify({models: [{name: "qwen2.5-coder:7b"}]}));
    prompts.push(JSON.parse(String(options?.body)).prompt);
    return new Response(JSON.stringify({response: "local answer"}));
  };
  try {
    assert.equal((await run("Design a Java queue")).provider, "ollama");
    assert.equal(state.lookup, 0); assert.equal(state.messages.length, 0);
    assert.deepEqual(prompts, ["Design a Java queue"]);
  } finally {globalThis.fetch = prior;}
});
