import {test} from "node:test";
import {strict as assert} from "node:assert";
import {planRoute, runRoutedPrompt, publicPayload, RouterDependencies, RoutingPolicy} from "../../escalation/routing";
import {AuditEvent} from "../../escalation/audit";
import {requestCloudOverride} from "../../escalation/override";
const publicPolicy: RoutingPolicy = {
  mode: "hybrid-public-prompts", trusted: true, isolatedPublicWindow: true,
  mandatoryLocalOnly: false, requireReviewer: false
};
function setup(initial: RoutingPolicy = {...publicPolicy}) {
  let policy = {...initial}, cancelled = false;
  const calls: string[] = [], previews: string[] = [], sends: string[] = [], events: AuditEvent[] = [];
  const deps: RouterDependencies = {
    policy: () => policy, cancelled: () => cancelled,
    local: async () => {calls.push("local"); return "local answer";},
    pickCopilot: async () => {
      calls.push("select-model");
      return {id: "copilot/test-model", label: "Test model", send: async prompt => {
        calls.push("send"); sends.push(prompt); return "cloud answer";
      }};
    },
    confirmPublic: async prompt => {calls.push("approve"); previews.push(prompt); return true;},
    audit: async event => {calls.push("audit:" + event.outcome); events.push(event);}
  };
  return {deps, calls, previews, sends, events, setPolicy: (p: RoutingPolicy) => {policy = p;}, cancel: () => {cancelled = true;}};
}
test("default mode, mandatory policy, project context and untrusted windows never discover Copilot", async () => {
  for (const changes of [{mode: "local-only" as const}, {mandatoryLocalOnly: true}, {isolatedPublicWindow: false},
    {trusted: false}, {requireReviewer: true}]) {
    const env = setup({...publicPolicy, ...changes});
    assert.equal((await runRoutedPrompt("Design a Java queue", env.deps)).provider, "ollama");
    assert.deepEqual(env.calls, ["local"]);
  }
});
test("simple tasks remain local even in an approved hybrid profile", async () => {
  const env = setup();
  assert.equal((await runRoutedPrompt("Explain a Java loop", env.deps)).provider, "ollama");
  assert.deepEqual(env.calls, ["local"]);
});
test("sensitive content goes local before model discovery or approval UI", async () => {
  for (const prompt of ["Design api_key=x", "Review email synthetic@example.test", "Debug AFM: 123456789",
    "Review AMKA: 12345678901", "Review confidential customer records", "Review Εμπιστευτικό έγγραφο",
    "Review ghp_" + "a".repeat(36), "Review Authorization: Bearer synthetic",
    "Review postgres://user:pass@database.test/db", "Review -----BEGIN ENCRYPTED PRIVATE KEY-----"]) {
    const env = setup();
    assert.equal((await runRoutedPrompt(prompt, env.deps)).provider, "ollama");
    assert.deepEqual(env.calls, ["local"]);
  }
});
test("complex public prompt is only a candidate until explicit approval", () => {
  assert.equal(planRoute("Design a Java queue", publicPolicy).route, "copilot-candidate");
  assert.equal(planRoute("Σχεδίασε μια ουρά Java", publicPolicy).route, "copilot-candidate");
});
test("only the exact approved snapshot reaches Copilot after approval and attempted audit", async () => {
  const env = setup(), prompt = "Design a Java queue";
  const result = await runRoutedPrompt(prompt, env.deps);
  assert.equal(result.provider, "copilot");
  assert.equal(result.text, "cloud answer");
  assert.deepEqual(env.sends, env.previews);
  assert.deepEqual(env.sends, [publicPayload(prompt)]);
  assert.deepEqual(env.calls, ["select-model", "approve", "audit:approved", "audit:attempted", "send", "audit:sent"]);
  assert.ok(env.events.every(e => !JSON.stringify(e).includes(prompt)));
  assert.match(env.events[0].model, /^id-[a-f0-9]{64}$/);
});
test("denying public approval audits cancellation without sending or fallback", async () => {
  const env = setup(); env.deps.confirmPublic = async () => false;
  assert.equal((await runRoutedPrompt("Design a Java queue", env.deps)).provider, "none");
  assert.equal(env.sends.length, 0);
  assert.equal(env.events[0].outcome, "cancelled");
  assert.ok(!env.calls.includes("local"));
});
test("policy change during public review prevents dispatch", async () => {
  const env = setup();
  env.deps.confirmPublic = async () => {env.setPolicy({...publicPolicy, mandatoryLocalOnly: true}); return true;};
  assert.equal((await runRoutedPrompt("Design a Java queue", env.deps)).reason, "policy-changed");
  assert.equal(env.sends.length, 0);
  assert.equal(env.events[0].outcome, "denied");
});
test("opening a project during audit prevents dispatch", async () => {
  const env = setup();
  env.deps.audit = async event => {
    env.events.push(event);
    if (event.outcome === "attempted") env.setPolicy({...publicPolicy, isolatedPublicWindow: false});
  };
  assert.equal((await runRoutedPrompt("Design a Java queue", env.deps)).reason, "failed");
  assert.equal(env.sends.length, 0);
});
test("pre-dispatch audit failures never send; post-send failure never retries", async () => {
  for (const failAt of [1, 2, 3]) {
    const env = setup(); let writes = 0;
    env.deps.audit = async () => {if (++writes === failAt) throw new Error("audit unavailable");};
    await assert.rejects(runRoutedPrompt("Design a Java queue", env.deps));
    assert.equal(env.sends.length, failAt === 3 ? 1 : 0);
    assert.ok(!env.calls.includes("local"));
  }
});
test("failed local model never triggers Copilot", async () => {
  const env = setup({...publicPolicy, mode: "local-only"});
  env.deps.local = async () => {throw new Error("local offline");};
  await assert.rejects(runRoutedPrompt("Design a Java queue", env.deps));
  assert.deepEqual(env.calls, []);
});
test("missing Copilot and provider failure do not silently select another provider", async () => {
  const missing = setup(); missing.deps.pickCopilot = async () => undefined;
  assert.equal((await runRoutedPrompt("Design a Java queue", missing.deps)).provider, "none");
  assert.ok(!missing.calls.includes("local"));
  const failed = setup();
  failed.deps.pickCopilot = async () => ({id: "test", label: "test", send: async () => {throw new Error("private provider diagnostics");}});
  assert.equal((await runRoutedPrompt("Design a Java queue", failed.deps)).reason, "failed");
  assert.ok(!failed.calls.includes("local"));
  assert.doesNotMatch(JSON.stringify(failed.events), /private provider diagnostics/);
});
test("cancellation before routing or after model selection sends no content", async () => {
  const before = setup(); before.cancel();
  assert.equal((await runRoutedPrompt("Design a Java queue", before.deps)).provider, "none");
  assert.deepEqual(before.calls, []);
  const after = setup();
  after.deps.pickCopilot = async () => {after.cancel(); return {id: "test", label: "test", send: async () => {throw new Error("unexpected");}};};
  assert.equal((await runRoutedPrompt("Design a Java queue", after.deps)).provider, "none");
  assert.deepEqual(after.sends, []);
});
test("oversized prompts stop before any provider or UI", async () => {
  const env = setup();
  await assert.rejects(runRoutedPrompt("x".repeat(20001), env.deps));
  assert.deepEqual(env.calls, []);
});
test("new credential signatures also block the legacy override gate", () => {
  for (const prompt of ["ghp_" + "a".repeat(36), "postgres://user:pass@db.test/db", "api_key=x"]) {
    assert.equal(requestCloudOverride({prompt, workspaceTrusted: true}, {cloudEnabled: true, allowOverrides: true},
      {reason: "Reviewed this synthetic example", confirmedCloudTransfer: true}).allowed, false);
  }
});
