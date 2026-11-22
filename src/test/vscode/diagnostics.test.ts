import { test } from "node:test";
import { strict as assert } from "node:assert";
import { Module } from "node:module";
import { explainFindingPrompt, findingsFromReport, previewLinks } from "../../vscode/reportFindings";
const load = (Module as unknown as {_load: (name: string, ...args: unknown[]) => unknown})._load;
(Module as unknown as {_load: unknown})._load = function(this: unknown, name: string, ...args: unknown[]) {
  return name === "vscode" ? {DiagnosticSeverity: {Error: 0, Warning: 1, Information: 2}} : load.call(this, name, ...args);
};
const {toDiagnosticEntries} = require("../../vscode/diagnostics") as typeof import("../../vscode/diagnostics");
const base = {severity: "high", evidence: "x", fix: "fix it", regressionTest: "test it", status: "potential" as const};
test("only file-backed findings become editor markers", () => {
  const entries = toDiagnosticEntries([
    {...base, title: "Bug", path: "file:///a/B.java", line: 7},
    {...base, title: "Selection", path: "selection", line: 1},
    {...base, title: "No line", path: "file:///a/C.java"},
    {...base, title: "Local rule: TLS certificate validation disabled", path: "untitled:Untitled-1", line: 3}
  ]);
  assert.deepEqual(entries.map(e => [e.uri, e.line]), [["file:///a/B.java", 7], ["untitled:Untitled-1", 3]]);
  assert.match(entries[0].message, /^Potential: Bug\nFix: fix it/);
  assert.doesNotMatch(entries[1].message, /^Potential:/);
});

test("scan report lines become Problems entries at the linked file and line", () => {
  const report = [
    "**Local security summary:** 3 files. No links here.",
    "**high · sql-injection** · [src/books.js:9](file:///p/src/books.js#L9) · Use parameters",
    "**HIGH · SQL injection: request input reaches this sink** · sink [src/books.js:9](file:///p/src/books.js#L9) · input [src/books.js:8](file:///p/src/books.js#L8)",
    "- **MEDIUM** · `CVE-1 lodash 4.0.0` · **vulnerable function `template` called at [src/a.js:3](file:///p/src/a.js#L3)**",
    "**Potential hardcoded credential** · [config.js:4](file:///p/config.js#L4) (value redacted)",
    "[same](file:///p/config.js#L4) [twice](file:///p/config.js#L4)"
  ].join("\n");
  const found = findingsFromReport(report);
  assert.deepEqual(found.map(f => [f.uri, f.line, f.severity]), [
    ["file:///p/src/books.js", 9, "high"], ["file:///p/src/books.js", 9, "high"], ["file:///p/src/a.js", 3, "medium"],
    ["file:///p/config.js", 4, "medium"], ["file:///p/config.js", 4, "medium"]]);
  assert.match(found[1].message, /^HIGH · SQL injection: request input reaches this sink · sink src\/books.js:9 · input src\/books.js:8$/);
  assert.doesNotMatch(found[2].message, /[*`]/);
});

test("saved reports use relative links because the Markdown preview drops file: links", () => {
  if (process.platform === "win32") return;
  assert.equal(previewLinks("x [b.js:9](file:///p/my%20app/b.js#L9) y [u](untitled:U-1#L2)", "/home/u/storage/reports"),
    "x [b.js:9](<../../../../p/my app/b.js#L9>) y [u](untitled:U-1#L2)");
});

test("explain-finding prompt marks the reported line and keeps only nearby code", () => {
  const lines = Array.from({length: 200}, (_, i) => "line" + (i + 1));
  const prompt = explainFindingPrompt({message: "SQL string concatenation", path: "src/a.js", line: 100}, lines, "javascript");
  assert.match(prompt, /Finding: SQL string concatenation\nLocation: src\/a.js:100/);
  assert.match(prompt, /  100 >\| line100\n/);
  assert.doesNotMatch(prompt, /line60\n|line130\n/);
});
