import { test } from "node:test";
import { strict as assert } from "node:assert";
import { LocalOllama } from "../../model/ollama";
import { runLocalReview } from "../../review/localReview";
import { formatReview, reviewSchema } from "../../review/review";

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

test("review adds a clearly labeled offline TLS indicator when Qwen returns zero findings", async () => {
  const vulnerable = [{path: "client.js", text: 'import https from "node:https";\nconst agent = new https.Agent({rejectUnauthorized: false});'}];
  const {client, prompts} = scripted(['{"findings":[]}', '{"findings":[]}']);
  const result = await runLocalReview(client, "review", vulnerable);
  assert.equal(prompts.length, 2);
  assert.equal(result?.proposed, 0, "offline indicators must not inflate AI proposals");
  assert.equal(result?.findings.length, 1);
  assert.equal(result?.findings[0].line, 2);
  assert.match(result!.findings[0].title, /^Local rule:/);
  assert.equal(result?.findings[0].status, "potential");
  assert.match(formatReview(result!), /Local rule: TLS certificate validation disabled/);
});

test("review keeps a taint-engine SQL injection even when the verifier rejects everything", async () => {
  const vulnerable = [{path: "books.js", text: "router.get('/books', (req, res) => {\n  const author = req.query.author;\n  db.query(\"SELECT * FROM books WHERE author = '\" + author + \"'\", cb);\n});"}];
  const {client} = scripted(['{"findings":[]}', '{"findings":[]}']);
  const result = await runLocalReview(client, "review", vulnerable, () => false, scripted(['{"verdicts":[]}']).client);
  assert.equal(result?.findings.length, 1);
  assert.equal(result?.findings[0].line, 3);
  assert.match(result!.findings[0].title, /^Local rule: SQL injection/);
});

test("review does not flag safe TLS or unrelated command execution", async () => {
  for (const code of [
    'const agent = new https.Agent({rejectUnauthorized: true});',
    'subprocess.run(["cat", filename], shell=False)'
  ]) {
    const path = code.startsWith("subprocess") ? "runner.py" : "client.js";
    const result = await runLocalReview(scripted(['{"findings":[]}', '{"findings":[]}']).client, "review", [{path,text:code}]);
    assert.equal(result?.findings.length, 0);
  }
});

test("offline review indicators retain source offsets and avoid duplicates", async () => {
  const sourceWithOffset = [{path:"client.js",startLine: 30,text:"const agent = new https.Agent({rejectUnauthorized: false});"}];
  const result = await runLocalReview(scripted(['{"findings":[]}', '{"findings":[]}']).client, "review", sourceWithOffset);
  assert.equal(result?.findings[0]?.line, 30);
});

test("Java JSON string concatenation is detected even if local model proposes zero findings",async()=>{
 const input=[{path:"Mapper.java",text:source}];
 const result=await runLocalReview(scripted(['{"findings":[]}','{"findings":[]}']).client,"review",input);
 assert.equal(result?.proposed,0);
 assert.equal(result?.findings.length,1);
 assert.match(result!.findings[0].title,/Local rule: Dynamic value/);
 assert.equal(result?.findings[0].line,3);
});
test("Java serialized object response does not produce local JSON-concatenation warning",async()=>{
 const input=[{path:"Mapper.java",text:'return Response.ok(new ErrorDto(message)).build();'}];
 const result=await runLocalReview(scripted(['{"findings":[]}','{"findings":[]}']).client,"review",input);
 assert.equal(result?.findings.length,0);
});

test("a stronger local judge re-checks only disputed findings: yes confirms the finding, no leaves it as possible", async () => {
  const fake = (real: boolean) => ({generate: async (prompt: string) =>
    /skeptical second reviewer/.test(prompt) ? '{"verdicts":[{"index":0,"supported":false}]}' : /Check one bug report/.test(prompt) ? JSON.stringify({real}) : json(valid)});
  for (const verdict of [true, false]) {
    const judged: string[] = [];
    const judge = async () => ({generate: async (prompt: string) => { judged.push(prompt); return JSON.stringify({real: verdict}); }});
    const result = await runLocalReview(fake(true), "review", source, () => false, fake(true), {depth: "fast", judge});
    assert.equal(judged.length, 1);
    assert.match(judged[0], /Check one bug report/);
    assert.equal(result?.findings.length, verdict ? 1 : 0);
    assert.equal(result?.disputed?.length ?? 0, verdict ? 0 : 1);
  }
  let asked = 0;
  await runLocalReview(fake(false), "review", source, () => false, fake(false), {depth: "fast", judge: async () => { asked++; return undefined; }});
  assert.equal(asked, 0, "no disputed finding, so the judge is never looked up");
});

test("HUSHAVYR_CONFIRM=1: a kept finding the narrow recheck rejects moves to Possible", async () => {
  const fake = (real: boolean) => ({generate: async (prompt: string) =>
    /skeptical second reviewer/.test(prompt) ? '{"verdicts":[{"index":0,"supported":true}]}' : /Check one bug report/.test(prompt) ? JSON.stringify({real}) : json(valid)});
  process.env.HUSHAVYR_CONFIRM = "1";
  try {
    for (const real of [true, false]) {
      const result = await runLocalReview(fake(real), "review", source, () => false, fake(real), {depth: "fast"});
      assert.equal(result?.findings.length, real ? 1 : 0);
      assert.equal(result?.disputed?.length ?? 0, real ? 0 : 1);
    }
  } finally { delete process.env.HUSHAVYR_CONFIRM; }
});

test("verify hedged: a finding stated as fact skips the verifier, a 'Potential ...' one is checked", async () => {
  for (const title of [valid.title, "Potential JSON break from tenant ID"]) {
    let verifierCalls = 0;
    const model = {generate: async () => json({...valid, title})};
    const verifier = {generate: async (prompt: string) => { verifierCalls++; return /skeptical second reviewer/.test(prompt) ? '{"verdicts":[{"index":0,"supported":false}]}' : JSON.stringify({real: false}); }};
    const result = await runLocalReview(model, "review", source, () => false, verifier, {depth: "fast", verify: "hedged"});
    const hedged = title.startsWith("Potential");
    assert.equal(result?.findings.some(f => f.title === title), !hedged);
    assert.equal(verifierCalls > 0, hedged);
  }
});
