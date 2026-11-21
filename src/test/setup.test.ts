import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Module } from "node:module";
import { LocalOllama } from "../ollama";
import { modelHint } from "../review";

const stub = {} as Record<string, unknown>;
const load = (Module as unknown as {_load: (name: string, ...args: unknown[]) => unknown})._load;
(Module as unknown as {_load: unknown})._load = function(this: unknown, name: string, ...args: unknown[]) {
  return name === "vscode" ? stub : load.call(this, name, ...args);
};
const {recommendedModel, detectTools, lowMemoryWarning} = require("../setup") as typeof import("../setup");

const ndjson = (...events: object[]) => new Response(events.map(e => JSON.stringify(e)).join("\n") + "\n");

test("ensureInstalled pulls a missing model, streams progress and rechecks", async () => {
  let installed = false;
  const progress: Array<number | undefined> = [];
  const client = new LocalOllama({model: "qwen2.5-coder:14b"}, async (url, init) => {
    if (url.endsWith("/api/tags")) return new Response(JSON.stringify({models: installed ? [{name: "qwen2.5-coder:14b"}] : []}));
    assert.ok(url.endsWith("/api/pull"));
    assert.equal(JSON.parse(String(init.body)).model, "qwen2.5-coder:14b");
    installed = true;
    return ndjson({status: "pulling", total: 200, completed: 50}, {status: "pulling", total: 200, completed: 200}, {status: "success"});
  });
  await client.ensureInstalled(undefined, percent => progress.push(percent));
  assert.deepEqual(progress, [0, 25, 100, undefined]);
});
test("ensureInstalled fails closed when the pull never reports success", async () => {
  const client = new LocalOllama({model: "qwen2.5-coder:14b"}, async url =>
    url.endsWith("/api/tags") ? new Response(JSON.stringify({models: []})) : ndjson({status: "pulling", total: 10, completed: 5}));
  await assert.rejects(client.ensureInstalled(), /Could not download/);
});
test("ensureInstalled does not pull when the server is unreachable", async () => {
  let pulls = 0;
  const client = new LocalOllama({model: "qwen2.5-coder:14b"}, async url => { if (url.endsWith("/api/pull")) pulls++; throw new Error("offline"); });
  await assert.rejects(client.ensureInstalled(), /unavailable/);
  assert.equal(pulls, 0);
  assert.equal(await client.isRunning(), false);
});
test("recommendedModel scales with memory", () => {
  const gb = 1024 ** 3;
  assert.equal(recommendedModel(8 * gb), "qwen2.5-coder:3b");
  assert.equal(recommendedModel(16 * gb), "qwen2.5-coder:7b");
  assert.equal(recommendedModel(24 * gb), "qwen2.5-coder:14b");
  assert.equal(recommendedModel(64 * gb), "qwen3-coder:30b");
  assert.equal(recommendedModel(32 * gb), "qwen3-coder:30b");
});
test("detectTools reports each missing binary", async () => {
  assert.deepEqual(await detectTools(async exe => exe === "semgrep"), {semgrep: true, gitleaks: false, trivy: false});
});
test("modelHint only nudges small models with no AI findings", () => {
  const empty = {findings: [], rejected: 0, proposed: 0};
  assert.match(modelHint("qwen2.5-coder:7b", empty), /larger local model/);
  assert.equal(modelHint("qwen2.5-coder:14b", empty), "");
  assert.equal(modelHint("llama3", empty), "");
  assert.equal(modelHint("qwen2.5-coder:7b", {...empty, error: "bad"}), "");
});
test("source has no double-escaped newline, quote or bracket sequences", () => {
  const dir = join(__dirname, "..", "..", "src");
  for (const file of readdirSync(dir).filter(f => f.endsWith(".ts"))) {
    assert.doesNotMatch(readFileSync(join(dir, file), "utf8"), /\\\\[nr`\[\]]/, file);
  }
});
test("lowMemoryWarning flags models that will not fit", () => {
  const gb = 1024 ** 3;
  assert.match(lowMemoryWarning("qwen2.5-coder:32b", 16 * gb), /needs about/);
  assert.equal(lowMemoryWarning("qwen2.5-coder:14b", 24 * gb), "");
  assert.equal(lowMemoryWarning("llama3", 8 * gb), "");
});

import {configuredModel} from "../model";
test("uses an explicit model setting, otherwise the best fit for memory", () => {
  const GB = 1024 ** 3;
  const unset = {inspect: () => ({}), get: <T>(_k: string, f: T) => f};
  assert.equal(configuredModel(unset, 24 * GB), "qwen2.5-coder:14b");
  assert.equal(configuredModel(unset, 8 * GB), "qwen2.5-coder:3b");
  assert.equal(configuredModel({...unset, inspect: () => ({globalValue: "deepseek-coder-v2:16b"})}, 64 * GB), "deepseek-coder-v2:16b");
});

test("review depth follows memory unless set", () => {
  const {autoDepth, configuredDepth} = require("../model") as typeof import("../model");
  const gb = 1024 ** 3;
  assert.equal(autoDepth(8 * gb), "light");
  assert.equal(autoDepth(16 * gb), "fast");
  assert.equal(autoDepth(32 * gb), "thorough");
  const config = (value: string) => ({get: <T>(_key: string, fallback?: T) => (value || fallback) as T});
  assert.equal(configuredDepth(config(""), 8 * gb), "light");
  assert.equal(configuredDepth(config("auto"), 32 * gb), "thorough");
  assert.equal(configuredDepth(config("thorough"), 8 * gb), "thorough");
});
