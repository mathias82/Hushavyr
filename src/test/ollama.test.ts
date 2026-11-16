import { test } from "node:test";
import { strict as assert } from "node:assert";
import { LocalOllama } from "../ollama";
test("only calls localhost Ollama and returns model text", async () => {
  let target = "";
  const client = new LocalOllama({model:"qwen2.5-coder:7b"}, async (url, init) => {
    target = url;
    assert.equal(init.method, "POST");
    assert.equal(JSON.parse(String(init.body)).stream, false);
    return new Response(JSON.stringify({response:"Hello from Qwen"}), {status:200});
  });
  assert.equal(await client.generate("Write a Java method"), "Hello from Qwen");
  assert.equal(target, "http://127.0.0.1:11434/api/generate");
});
test("never falls back to cloud on connection failure", async () => {
  let calls=0;
  const client = new LocalOllama({model:"qwen2.5-coder:7b"}, async () => { calls++; throw new Error("offline"); });
  await assert.rejects(client.generate("test"), /No cloud fallback/);
  assert.equal(calls,1);
});
test("invalid model is rejected", () => {
  assert.throws(() => new LocalOllama({model:"invalid model name"}));
});
test("empty prompts do not reach the transport", async () => {
  const client = new LocalOllama({model:"qwen2.5-coder:7b"}, async () => { throw new Error("Should not call"); });
  await assert.rejects(client.generate("  "), /Empty prompt/);
});

test("structured review requests Ollama JSON mode and temperature zero", async () => {
  const client = new LocalOllama({model:"qwen2.5-coder:7b"}, async (_url, init) => {
    const payload = JSON.parse(String(init.body));
    assert.equal(payload.format,"json");
    assert.equal(payload.options.temperature,0);
    return new Response(JSON.stringify({response:'{"findings":[]}'}),{status:200});
  });
  assert.equal(await client.generate("Review Java", {json:true}), '{"findings":[]}');
});


test("rejects remote endpoints, credentials, paths and insecure redirect handling", async () => {
  for (const endpoint of ["https://example.test", "http://example.test", "http://127.0.0.1:11434/path", "http://user:pass@127.0.0.1:11434", "http://127.0.0.1:11434?target=remote"]) {
    assert.throws(() => new LocalOllama({model: "qwen", endpoint}));
  }
  let target = "";
  const client = new LocalOllama({model: "qwen", endpoint: "http://localhost:11435"}, async (url, init) => {
    target = url; assert.equal(init.redirect, "error");
    return new Response(JSON.stringify({response: "local"}));
  });
  await client.generate("test");
  assert.equal(target, "http://127.0.0.1:11435/api/generate");
});
test("checks installed local models without invoking generation or pulling", async () => {
  for (const installed of [true, false]) {
    const client = new LocalOllama({model: "qwen"}, async (url, init) => {
      assert.equal(url, "http://127.0.0.1:11434/api/tags"); assert.equal(init.method, "GET");
      return new Response(JSON.stringify({models: installed ? [{name: "qwen:latest"}] : []}));
    });
    if (installed) await client.ensureAvailable();
    else await assert.rejects(client.ensureAvailable(), /not installed locally/);
  }
});
test("local request timeout and cancellation abort the actual transport signal", async () => {
  const client = new LocalOllama({model: "qwen", timeoutMs: 15}, async (_url, init) => new Promise((_, reject) => {
    init.signal!.addEventListener("abort", () => reject(new Error("aborted")), {once: true});
  }));
  await assert.rejects(client.generate("test"), /No cloud fallback/);
  const controller = new AbortController();
  const pending = client.generate("test", {signal: controller.signal});
  controller.abort();
  await assert.rejects(pending, /No cloud fallback/);
});

test("oversized structured prompts fail before local transport", async () => {
  let calls = 0;
  const client = new LocalOllama({model: "qwen"}, async () => {calls++; throw new Error("unexpected");});
  await assert.rejects(client.generate("x".repeat(28001), {schema: {type: "object"}}), /context budget/);
  assert.equal(calls, 0);
});
