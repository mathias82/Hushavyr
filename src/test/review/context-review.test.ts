import { test } from "node:test";
import { strict as assert } from "node:assert";
import { sourcePrompt, validateContext } from "../../review/context";
import { validateReview } from "../../review/review";
import { verifyReview } from "../../review/verifyReview";
import { runLocalReview } from "../../review/localReview";
const sources = [{path: "Mapper.java", text: 'public class Mapper {\n  return json + tenant.getId();\n}'},
  {path: "Tenant.java", text: 'public String getId() { return id; }'}];
const candidate = {title: "Unescaped JSON input", path: "Mapper.java", startLine: 2, endLine: 2,
  severity: "medium", fix: "Serialize an object", regressionTest: "Check quotes in tenant ID"};
const raw = (value = candidate) => JSON.stringify({findings: [value]});

test("line evidence is extracted from real source without model quote escaping", () => {
  const result = validateReview(raw(), sources);
  assert.equal(result.findings[0].evidence, '  return json + tenant.getId();');
  assert.equal(result.findings[0].line, 2);
  assert.equal(result.findings[0].path, "Mapper.java");
  assert.equal(result.findings[0].status, "potential");
  assert.match(sourcePrompt(sources), /2:   return json/);
});
test("rejects invented files, metadata evidence and invalid ranges", () => {
  for (const item of [{...candidate, path: "Absent.java"}, {...candidate, startLine: 0},
    {...candidate, startLine: 3, endLine: 2}, {...candidate, endLine: 99},
    {...candidate, startLine: 2.5}, {...candidate, evidence: "SOURCE Mapper.java"},
    {...candidate, evidence: sources[0].text.split('\n')[0]}]) {
    assert.equal(validateReview(JSON.stringify({findings: [item]}), sources).findings.length, 0);
  }
});
test("multi-file legacy evidence must name its actual file", () => {
  const legacy = {...candidate, startLine: undefined, endLine: undefined, evidence: sources[1].text};
  assert.equal(validateReview(JSON.stringify({findings: [legacy]}), sources).findings.length, 0);
  assert.equal(validateReview(JSON.stringify({findings: [{...legacy, path: "Tenant.java"}]}), sources).findings.length, 1);
});
test("context bounds include instruction and reject truncation or duplicate paths", () => {
  assert.throws(() => validateContext("x", Array.from({length: 9}, (_, i) => ({path: String(i), text: "code"}))));
  assert.throws(() => validateContext("x", [sources[0], sources[0]]));
  assert.throws(() => validateContext("x", [{path: "file", text: "α".repeat(50000)}]));
  assert.throws(() => validateContext("x".repeat(100001), []));
  assert.doesNotThrow(() => validateContext("Review", sources));
});
test("separate local pass can reject a source-matching but unsupported claim", async () => {
  let prompt = "";
  const result = await verifyReview({generate: async text => {prompt ||= text; return '{"verdicts":[{"index":0,"supported":false}]}';}}, validateReview(raw(), sources), sources);
  assert.equal(result?.findings.length, 0);
  assert.equal(result?.verifierRejected, 1);
  assert.match(prompt, /skeptical second reviewer/);
  assert.match(prompt, /Tenant.java/);
});
test("a rejected finding gets one narrow recheck: it is never restored, but a disagreement is reported as a doubt", async () => {
  for (const [real, doubts] of [[true, 1], [false, 0]] as const) {
    const prompts: string[] = [];
    const replies = ['{"verdicts":[{"index":0,"supported":false}]}', JSON.stringify({real})];
    const result = await verifyReview({generate: async text => { prompts.push(text); return replies[prompts.length - 1]; }}, validateReview(raw(), sources), sources);
    assert.equal(result?.findings.length, 0);
    assert.equal(result?.verifierRejected, 1);
    assert.equal(result?.disputed?.length ?? 0, doubts);
    assert.match(prompts[1], /Check one bug report[\s\S]*FILE Mapper.java \(lines 1-3\):\n1: public class Mapper/);
  }
});
test("verifier agreement never promotes a finding to confirmed", async () => {
  const result = await verifyReview({generate: async () => '{"verdicts":[{"index":0,"supported":true}]}'}, validateReview(raw(), sources), sources);
  assert.equal(result?.findings[0].verification, "supported");
  assert.equal(result?.findings[0].status, "potential");
});
test("invalid, missing or duplicate verifier verdicts leave findings unverified", async () => {
  for (const response of ['bad', '{"verdicts":[]}', '{"verdicts":[{"index":0,"supported":"true"}]}',
    '{"verdicts":[{"index":0,"supported":true},{"index":0,"supported":false}]}']) {
    const result = await verifyReview({generate: async () => response}, validateReview(raw(), sources), sources);
    assert.equal(result?.findings[0].verification, "unverified");
    assert.equal(result?.verifierFailed, true);
  }
});
test("review, repair and second pass have a three-request maximum", async () => {
  let requests = 0;
  const client = {generate: async () => ++requests === 1 ? 'bad' : requests === 2 ? raw() : '{"verdicts":[{"index":0,"supported":true}]}'};
  const result = await runLocalReview(client, "review", sources, () => false, client);
  assert.equal(requests, 3);
  assert.equal(result?.findings[0].verification, "supported");
});
test("cancellation suppresses a completed verifier result", async () => {
  let cancelled = false;
  const result = await verifyReview({generate: async () => {cancelled = true; return '{"verdicts":[]}';}}, validateReview(raw(), sources), sources, () => cancelled);
  assert.equal(result, undefined);
});

test("selection offsets preserve actual file line numbers", () => {
  const selection = [{path: "Mapper.java", text: sources[0].text.split('\n')[1], startLine: 28}];
  const result = validateReview(raw({...candidate, startLine: 28, endLine: 28}), selection);
  assert.equal(result.findings[0].line, 28);
  assert.match(sourcePrompt(selection), /28:   return json/);
  assert.equal(validateReview(raw(candidate), selection).findings.length, 0);
});
