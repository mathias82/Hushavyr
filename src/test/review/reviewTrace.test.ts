import { test } from "node:test";
import { strict as assert } from "node:assert";
import { benchmarkCases, runCase, LossStage } from "../../benchmark";
import { ReviewDepth } from "../../review/localReview";

type Kind = "general" | "retry" | "security" | "robustness" | "verify" | "recheck" | "targeted";
const kindOf = (prompt: string): Kind =>
  prompt.includes("LOCAL VALIDATOR FEEDBACK") ? "retry" : prompt.includes("FOCUS FOR THIS PASS: security") ? "security"
  : prompt.includes("FOCUS FOR THIS PASS: robustness") ? "robustness" : prompt.includes("skeptical second reviewer") ? "verify"
  : prompt.includes("Check one bug report") ? "recheck" : prompt.includes("Answer one question") ? "targeted" : "general";
const DEFAULTS: Record<Kind, string> = {general: '{"findings":[]}', retry: '{"findings":[]}', security: '{"findings":[]}', robustness: '{"findings":[]}',
  verify: '{"verdicts":[{"index":0,"supported":true}]}', recheck: '{"real":false}', targeted: '{"bug":false}'};

function scripted(answers: Partial<Record<Kind, (string | Error)[]>>) {
  const queues = Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, [...v]])) as Partial<Record<Kind, (string | Error)[]>>;
  const prompts: string[] = [];
  return {prompts, client: {generate: async (prompt: string) => {
    prompts.push(prompt);
    const kind = kindOf(prompt), answer = queues[kind]?.length ? queues[kind]!.shift()! : DEFAULTS[kind];
    if (answer instanceof Error) throw answer;
    return answer;
  }}};
}

const overflow = benchmarkCases.find(c => c.id === "integer-overflow-bug")!;
const finding = (line: number, title = "Integer overflow in multiplication", fix = "Cast to long before multiplying", extra = {}) =>
  JSON.stringify({findings: [{title, severity: "high", path: "Price.java", startLine: line, endLine: line, fix, regressionTest: "Use large quantity and price", ...extra}]});
const invented = finding(3, undefined, undefined, {evidence: "return price * count;"});
const rejected = '{"verdicts":[{"index":0,"supported":false}]}';

const scenarios: {name: string; depth?: ReviewDepth; answers: Partial<Record<Kind, (string | Error)[]>>; loss: LossStage}[] = [
  {name: "kept by the verifier", answers: {general: [finding(3)]}, loss: "found"},
  {name: "invalid JSON, then the retry finds it", answers: {general: ["not json"], retry: [finding(3)]}, loss: "found"},
  {name: "invalid JSON twice", answers: {general: ["not json"], retry: ["still not json"]}, loss: "inconclusive"},
  {name: "model request fails", answers: {general: [new Error("timeout")]}, loss: "inconclusive"},
  {name: "nothing proposed", answers: {}, loss: "not_proposed"},
  {name: "verifier rejects, recheck agrees", answers: {general: [finding(3)], verify: [rejected]}, loss: "verifier_rejected"},
  {name: "verifier rejects, recheck disagrees", answers: {general: [finding(3)], verify: [rejected], recheck: ['{"real":true}']}, loss: "possible_only"},
  {name: "verifier returns invalid JSON", answers: {general: [finding(3)], verify: ["oops"]}, loss: "found"},
  {name: "validator rejects invented evidence", answers: {general: [invented], retry: [invented]}, loss: "validator_rejected"},
  {name: "validator rejects a line outside the file", answers: {general: [finding(30)], retry: [finding(30)]}, loss: "wrong_location"},
  {name: "right line, wrong mechanism", answers: {general: [finding(3, "Missing input validation", "Validate the inputs")]}, loss: "wrong_mechanism"},
  {name: "right mechanism, wrong line", answers: {general: [finding(2)]}, loss: "wrong_location"},
  {name: "thorough: only the robustness lens finds it", depth: "thorough", answers: {robustness: [finding(3)]}, loss: "found"}
];

for (const s of scenarios) test("trace changes nothing and attributes the miss: " + s.name, async () => {
  const plain = scripted(s.answers), traced = scripted(s.answers);
  const options = {depth: s.depth ?? "fast", verify: "batch" as const};
  const without = await runCase(overflow, plain.client, plain.client, options);
  const withTrace = await runCase(overflow, traced.client, traced.client, {...options, trace: true});
  assert.deepEqual(withTrace.result, without.result);
  assert.equal(withTrace.error, without.error);
  assert.deepEqual(traced.prompts, plain.prompts);
  assert.equal(without.trace, undefined);
  const trace = withTrace.trace!;
  assert.equal(Object.values(trace.calls).reduce((a, b) => a + b, 0), plain.prompts.length);
  assert.equal("lossStage" in trace && trace.lossStage, s.loss);
});

test("trace records where each call went, invalid answers and the origin of final findings", async () => {
  const {client} = scripted({general: ["not json"], retry: [finding(3)], verify: ["oops"]});
  const {trace} = await runCase(overflow, client, client, {depth: "fast", trace: true});
  assert.deepEqual(trace!.calls, {general: 1, retry: 1, verify: 1, targeted: 1});
  assert.deepEqual(trace!.invalidJson, {general: 1, verify: 1});
  assert.equal(trace!.stages.verified[0], "3 Integer overflow in multiplication");
  assert.deepEqual(trace!.origins, ["retry"]);
  assert.doesNotMatch(JSON.stringify(trace), /quantity \* unitCents|Cast to long/, "no source or fix text in the trace");
});

test("expected bugs never reach the model: same prompts with and without the label", async () => {
  const labelled = scripted({general: [finding(3)], verify: [rejected], recheck: ['{"real":true}']});
  const unlabelled = scripted({general: [finding(3)], verify: [rejected], recheck: ['{"real":true}']});
  await runCase(overflow, labelled.client, labelled.client, {depth: "thorough", trace: true});
  await runCase({...overflow, expected: undefined}, unlabelled.client, unlabelled.client, {depth: "thorough", trace: true});
  assert.deepEqual(labelled.prompts, unlabelled.prompts);
  assert.ok(labelled.prompts.every(p => !p.includes(overflow.id) && !p.includes(String(overflow.expected!.mechanism))));
});
