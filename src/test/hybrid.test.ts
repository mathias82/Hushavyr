import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { staticReview, semgrepToFindings } from "../staticReview";
import { mergeFindings, runLocalReview, LENSES } from "../localReview";
import { callContext, definitionSnippet } from "../callContext";
import { collectImports, reachability } from "../reachability";
import { toSarif, sarifLevel } from "../sarif";
import { ResultCache } from "../reviewCache";
import { scanFolder } from "../cli";
import { staticGateProblems } from "../benchmark";
import { reviewSummary, Finding } from "../review";

const sqlSource = [{path: "file:///Repo.java", text: "class Repo {\n  void find(String id) {\n    stmt.executeQuery(\"SELECT * FROM t WHERE id=\" + id);\n  }\n}"}];
const semgrepJson = JSON.stringify({results: [{path: "f0.java", start: {line: 3},
  extra: {message: "SQL built by concatenation", severity: "ERROR", metadata: {fix: "Use PreparedStatement", test: "Quote in id"}}}]});

test("static review maps semgrep hits back to the original file and line", async () => {
  const result = await staticReview(sqlSource, "rules.yml", async (args, cwd) => {
    assert.ok(args.includes("--metrics=off"));
    assert.ok(cwd.includes("hushavyr-review-"));
    return semgrepJson;
  });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.findings.map(f => [f.path, f.line, f.severity, f.fix]), [["file:///Repo.java", 3, "high", "Use PreparedStatement"]]);
  assert.match(result.findings[0].title, /^Local rule: SQL/);
  assert.deepEqual(semgrepToFindings("not json", sqlSource), []);
});

test("static review falls back to bundled rules when semgrep is missing", async () => {
  const missing = await staticReview(sqlSource, "rules.yml", async () => { throw Object.assign(new Error("no"), {code: "ENOENT"}); });
  assert.equal(missing.status, "missing");
  assert.ok(missing.findings.every(f => f.severity === "high" && f.path === "file:///Repo.java"));
});

const finding = (line: number, title = "Issue " + line): Finding => ({title, severity: "medium", evidence: "x".repeat(10),
  fix: "fix", regressionTest: "test", status: "potential", path: "file:///A.java", line});

test("mergeFindings keeps the first finding per location", () => {
  const merged = mergeFindings([finding(3, "model")], [finding(3, "static"), finding(9)]);
  assert.deepEqual(merged.map(f => f.title), ["model", "Issue 9"]);
});

test("thorough review runs the general pass plus each lens and merges static candidates", async () => {
  const prompts: string[] = [];
  const client = {generate: async (prompt: string) => { prompts.push(prompt); return '{"findings":[]}'; }};
  const result = await runLocalReview(client, "review", sqlSource, () => false, undefined,
    {depth: "thorough", staticFindings: Promise.resolve([{...finding(3), path: "file:///Repo.java", evidence: sqlSource[0].text.split("\n")[2].trim()}])});
  assert.equal(prompts.length, 1 + LENSES.length);
  assert.ok(prompts.slice(1).every((p, i) => p.startsWith(prompts[0]) && p.endsWith(LENSES[i])));
  assert.equal(result?.staticCandidates, 1);
  assert.ok(result?.findings.some(f => f.line === 3));
});

test("call context pulls the callee definition from another file", () => {
  const caller = {path: "file:///Svc.java", text: "class Svc { void run(String id) { repo.lookup(id); } }"};
  const files = [{path: "file:///Repo.java", text: "class Repo {\n  void lookup(String id) {\n    query(id);\n  }\n}"}];
  const extra = callContext(caller, files);
  assert.equal(extra.length, 1);
  assert.equal(extra[0].path, "file:///Repo.java");
  assert.equal(extra[0].startLine, 2);
  assert.match(extra[0].text, /query\(id\)/);
  assert.equal(definitionSnippet("def other():\n  pass", "missing"), undefined);
});

test("reachability separates imported from transitive dependencies", () => {
  const imports = new Set([...collectImports("A.java", "import com.fasterxml.jackson.databind.ObjectMapper;"),
    ...collectImports("a.ts", "import _ from \"lodash/fp\";"), ...collectImports("a.py", "import yaml, os")]);
  assert.equal(reachability("com.fasterxml.jackson.core:jackson-databind", "pom.xml", imports), "imported");
  assert.equal(reachability("org.apache.commons:commons-text", "pom.xml", imports), "not-imported");
  assert.equal(reachability("lodash", "package-lock.json", imports), "imported");
  assert.equal(reachability("PyYAML", "requirements.txt", imports), "imported");
  assert.equal(reachability("lodash", "package-lock.json", new Set()), "unknown");
});

test("SARIF output is valid 2.1.0 with mapped levels", () => {
  const sarif = toSarif([{ruleId: "sql", message: "m", path: "./src\\A.java", line: 0, level: sarifLevel("HIGH")}], "1.0.0") as any;
  assert.equal(sarif.version, "2.1.0");
  assert.equal(sarif.runs[0].results[0].level, "error");
  assert.equal(sarif.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri, "src/A.java");
  assert.equal(sarif.runs[0].results[0].locations[0].physicalLocation.region.startLine, 1);
  assert.equal(sarifLevel("moderate"), "warning");
  assert.equal(sarifLevel("low"), "note");
});

test("result cache is keyed by content and evicts the least recently used entry", () => {
  const cache = new ResultCache<number>(2);
  assert.equal(ResultCache.key("m", [{text: "a"}]), ResultCache.key("m", [{text: "a"}]));
  assert.notEqual(ResultCache.key("m", [{text: "a"}]), ResultCache.key("m", [{text: "b"}]));
  cache.set("a", 1); cache.set("b", 2); cache.get("a"); cache.set("c", 3);
  assert.equal(cache.get("b"), undefined);
  assert.equal(cache.get("a"), 1);
});

test("CLI folder scan reports credentials and skips dependency folders", async () => {
  const root = await mkdtemp(join(tmpdir(), "hushavyr-cli-"));
  try {
    await writeFile(join(root, "config.js"), "const password = \"hunter2-super-secret-value\";\n");
    await writeFile(join(root, "package-lock.json"), "{\n  \"password\": \"hunter2-super-secret-value\"\n}\n");
    await mkdir(join(root, "node_modules"));
    await writeFile(join(root, "node_modules", "dep.js"), "const password = \"hunter2-super-secret-value\";\n");
    const results = await scanFolder(root, join(__dirname, "..", "..", "rules", "hushavyr-review.yml"));
    assert.ok(results.some(r => r.path === "config.js" && r.level === "error"));
    assert.ok(results.every(r => !r.path.startsWith("node_modules") && r.path !== "package-lock.json"));
  } finally { await rm(root, {recursive: true, force: true}); }
});

test("static gate fails on missing semgrep, false positives or missed security cases", () => {
  const ok = {semgrep: "ok", fixtureCount: 35, truePositives: 10, falsePositives: 0, securityRecall: 1, missed: [], falsePositiveCases: []};
  assert.deepEqual(staticGateProblems(ok as any), []);
  assert.equal(staticGateProblems({...ok, semgrep: "missing"} as any).length > 0, true);
  assert.equal(staticGateProblems({...ok, falsePositives: 1, falsePositiveCases: ["x"]} as any).length > 0, true);
  assert.equal(staticGateProblems({...ok, securityRecall: 0.5, missed: ["y"]} as any).length > 0, true);
});

test("review summary names the most serious issue to fix first", () => {
  const summary = reviewSummary({findings: [finding(2, "Minor"), {...finding(7, "Local rule: SQL injection"), severity: "high"}], rejected: 0});
  assert.match(summary, /2 issue/);
  assert.match(summary, /Fix first:\*\* SQL injection \(`A.java:7`\)/);
  assert.match(reviewSummary({findings: [], rejected: 0}), /nothing to fix/);
});

test("/security Semgrep uses the full bundled rule pack and short rule ids", async () => {
  const { runSemgrep } = await import("../semgrep");
  let config = "";
  const result = await runSemgrep("/repo", (_file, args, _options, callback) => {
    config = args[args.indexOf("--config") + 1];
    callback(null, JSON.stringify({results: [{path: "src/A.java", start: {line: 4}, check_id: "Users.me.rules.hushavyr.java-sql-concatenation", extra: {severity: "ERROR", message: "SQL"}}]}), "");
  });
  assert.match(config, /hushavyr-review\.yml$/);
  assert.equal(result.findings[0].rule, "java-sql-concatenation");
});
