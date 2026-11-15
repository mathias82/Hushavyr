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
  assert.throws(() => new LocalOllama({model:"https://external.example/"}));
});
test("empty prompts do not reach the transport", async () => {
  const client = new LocalOllama({model:"qwen2.5-coder:7b"}, async () => { throw new Error("Should not call"); });
  await assert.rejects(client.generate("  "), /Empty prompt/);
});
