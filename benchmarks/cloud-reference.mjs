// D3: scores cloud models on the synthetic benchmark fixtures only (never user code), next to the local model, with the same prompt.
// Usage: node benchmarks/cloud-reference.mjs [out.json]   env: CLOUD_MODELS=claude-sonnet-5.5,gpt-6.1-sol  OLLAMA_MODEL=qwen2.5-coder:14b
// CLOUD_IDS=<regex> runs and scores only the matching fixture ids. CLOUD_RAW=<file> keeps the raw responses.
import {execFileSync, spawn} from "node:child_process";
import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, dirname} from "node:path";
import {fileURLToPath} from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bench = join(root, "dist", "benchmark.js");
const prompts = JSON.parse(execFileSync(process.execPath, [bench, "--prompts"], {maxBuffer: 1 << 26}).toString());
const cloud = (process.env.CLOUD_MODELS ?? "claude-sonnet-5.5,gpt-6.1-sol").split(",").filter(Boolean);
const local = process.env.OLLAMA_MODEL ?? "qwen2.5-coder:14b";

function copilot(model, prompt) {
  const cwd = mkdtempSync(join(tmpdir(), "hush-d3-"));
  return new Promise(resolve => {
    const child = spawn("copilot", ["--model", model, "-p", prompt + "\n\nReply with the JSON only.", "-s", "--available-tools=",
      "--disable-builtin-mcps", "--no-custom-instructions", "--no-ask-user"], {cwd, stdio: ["ignore", "pipe", "pipe"]});
    let out = "";
    child.stdout.on("data", d => { out += d; });
    child.on("close", () => { rmSync(cwd, {recursive: true, force: true}); resolve(out.trim().replace(/^```(?:json)?\s*|\s*```$/g, "")); });
  });
}

async function ollama(prompt) {
  const res = await fetch("http://localhost:11434/api/generate", {method: "POST",
    body: JSON.stringify({model: local, prompt, format: "json", stream: false, options: {temperature: 0}})});
  return (await res.json()).response ?? "";
}

const allIds = Object.keys(prompts), only = process.env.CLOUD_IDS && new RegExp(process.env.CLOUD_IDS);
const ids = only ? allIds.filter(id => only.test(id)) : allIds;
const providers = {};
const timing = {};
const cloudRuns = cloud.map(async model => {
  const started = Date.now(), out = {};
  for (let i = 0; i < ids.length; i += 4)
    await Promise.all(ids.slice(i, i + 4).map(async id => { out[id] = await copilot(model, prompts[id]); }));
  providers[model] = out; timing[model] = Math.round((Date.now() - started) / 1000);
});
// CLOUD_ONLY=1 leaves Ollama free for a concurrent local benchmark.
const localRun = (async () => {
  if (process.env.CLOUD_ONLY === "1") return;
  const started = Date.now(), out = {};
  for (const id of ids) out[id] = await ollama(prompts[id]);
  providers[local + " (single pass)"] = out; timing[local + " (single pass)"] = Math.round((Date.now() - started) / 1000);
})();
await Promise.all([...cloudRuns, localRun]);

const file = join(mkdtempSync(join(tmpdir(), "hush-d3-")), "providers.json");
const empty = JSON.stringify({findings: []});
for (const name of Object.keys(providers)) for (const id of allIds) providers[name][id] ??= empty;
writeFileSync(file, JSON.stringify({providers}));
if (process.env.CLOUD_RAW) writeFileSync(process.env.CLOUD_RAW, JSON.stringify(Object.fromEntries(Object.entries(providers).map(([n, r]) => [n, Object.fromEntries(ids.map(id => [id, r[id]]))])), null, 2));
const report = JSON.parse(execFileSync(process.execPath, [bench, "--compare", file], {maxBuffer: 1 << 26}).toString());
rmSync(dirname(file), {recursive: true, force: true});
for (const p of report.providers) {
  p.cases = p.cases.filter(c => ids.includes(c.id));
  p.totals = p.cases.reduce((t, c) => ({truePositive: t.truePositive + c.truePositive, falsePositive: t.falsePositive + c.falsePositive, falseNegative: t.falseNegative + c.falseNegative}), {truePositive: 0, falsePositive: 0, falseNegative: 0});
  const {truePositive: tp, falsePositive: fp, falseNegative: fn} = p.totals;
  p.precision = tp + fp ? tp / (tp + fp) : null; p.recall = tp + fn ? tp / (tp + fn) : null;
}
const summary = report.providers.map(p => ({model: p.name, precision: p.precision, recall: p.recall, ...p.totals, seconds: timing[p.name]}));
console.table(summary);
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify({summary, cases: Object.fromEntries(report.providers.map(p => [p.name, p.cases]))}, null, 2));
