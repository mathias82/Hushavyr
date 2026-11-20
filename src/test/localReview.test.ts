import { test } from "node:test";
import { strict as assert } from "node:assert";
import { LocalOllama } from "../ollama";
import { runLocalReview } from "../localReview";
import { formatReview, reviewSchema } from "../review";

// Same failure mechanism as the mapper in the reported VS Code example.
const source = [
  "public Response toResponse(TenantNotFoundException e) {",
  '  return Response.status(Response.Status.NOT_FOUND)',
  '    .entity("{\\"error\\": \\"Tenant not found: " + e.getTenantId() + "\\"}")',
  '    .type("application/json").build();',
  "}"
].join("\n");
const valid = {
  title: "Tenant ID can break JSON serialization", severity: "medium",
  evidence: source.split("\n")[2].trim(),
  fix: "Use a JSON object or DTO serializer so a tenant ID containing a quote is escaped.",
  regressionTest: "Pass a tenant ID containing a quote and parse the response as JSON."
};
function scripted(responses: (string | Error)[]) {
  const prompts: string[] = [];
  const client = new LocalOllama({model: "qwen2.5-coder:7b"}, async (url, init) => {
    if (url.endsWith("/api/show")) return new Response(JSON.stringify({model_info: {"general.architecture": "qwen2"}}));
    assert.equal(url, "http://127.0.0.1:11434/api/generate");
    const payload = JSON.parse(String(init.body));
    assert.deepEqual(payload.format, reviewSchema);
    assert.equal(payload.options.temperature, 0);
    prompts.push(payload.prompt);
    const response = responses.shift();
    if (response instanceof Error) throw response;
    assert.equal(typeof response, "string", "unexpected extra local request");
    return new Response(JSON.stringify({response}), {status: 200});
  });
  return {client, prompts};
}
const json = (finding: object) => JSON.stringify({findings: [finding]});

test("repairs rejected mapper evidence once and validates the replacement", async () => {
  const {client, prompts} = scripted([json({...valid, evidence: "invented source expression"}), json(valid)]);
  const result = await runLocalReview(client, "check code for bugs", source);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /LOCAL VALIDATOR FEEDBACK:.*exact source substring/);
  assert.equal(result?.findings.length, 1);
  assert.equal(result?.findings[0].status, "potential");
  assert.equal(result?.findings[0].evidence, valid.evidence);
});

test("never promotes unsupported SQL claims even after repair", async () => {
  const unsupported = json({...valid, title: "SQL injection"});
  const {client, prompts} = scripted([unsupported, unsupported]);
  const result = await runLocalReview(client, "review", source);
  assert.equal(prompts.length, 2);
  assert.equal(result?.findings.length, 0);
  assert.equal(result?.rejected, 1);
  assert.match(formatReview(result!), /SQL injection claim has no SQL sink/);
  assert.doesNotMatch(formatReview(result!), /Use a JSON object/);
});

test("repairs malformed JSON but never loops past two requests", async () => {
  const {client, prompts} = scripted(["bad JSON", "still bad"]);
  const result = await runLocalReview(client, "review", source);
  assert.equal(prompts.length, 2);
  assert.equal(result?.findings.length, 0);
  assert.equal(result?.retryFailed, true);
});

test("empty review triggers one focused retry while useful findings do not", async () => {
  const empty = scripted(['{"findings":[]}', '{"findings":[]}']);
  const result = await runLocalReview(empty.client, "review", source);
  assert.equal(empty.prompts.length, 2);
  assert.equal(result?.proposed, 0);
  assert.match(empty.prompts[1], /No candidate findings were proposed/);
  const useful = scripted([json(valid)]);
  await runLocalReview(useful.client, "review", source);
  assert.equal(useful.prompts.length, 1);
});

test("failed repair preserves validation feedback without leaking raw model output", async () => {
  const {client, prompts} = scripted([json({...valid, evidence: "fabricated secret evidence"}), new Error("offline")]);
  const result = await runLocalReview(client, "review", source);
  assert.equal(prompts.length, 2);
  assert.equal(result?.retryFailed, true);
  assert.match(formatReview(result!), /exact source substring/);
  assert.doesNotMatch(formatReview(result!), /fabricated secret/);
});

test("cancellation prevents repair and suppresses returned results", async () => {
  const {client, prompts} = scripted(["bad JSON"]);
  const result = await runLocalReview(client, "review", source, () => prompts.length > 0);
  assert.equal(result, undefined);
  assert.equal(prompts.length, 1);
  const preCancelled = scripted([]);
  assert.equal(await runLocalReview(preCancelled.client, "review", source, () => true), undefined);
  assert.equal(preCancelled.prompts.length, 0);
});

test("reports empty and rejected reviews distinctly without showing rejected model evidence", async () => {
  const empty = await runLocalReview(scripted(['{"findings":[]}', '{"findings":[]}']).client, "review", source);
  assert.match(formatReview(empty!), /0 proposed/);
  assert.match(formatReview(empty!), /model proposed no findings/);
  const rejected = await runLocalReview(scripted([json({...valid, title:"SQL injection", evidence:"PRIVATE_VALUE_NOT_IN_SOURCE"}), json({...valid, title:"SQL injection", evidence:"PRIVATE_VALUE_NOT_IN_SOURCE"})]).client, "review", source);
  assert.match(formatReview(rejected!), /1 proposed/);
  assert.match(formatReview(rejected!), /inconclusive/);
  assert.doesNotMatch(formatReview(rejected!), /PRIVATE_VALUE_NOT_IN_SOURCE/);
});
