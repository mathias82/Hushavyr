import { test } from "node:test";
import { strict as assert } from "node:assert";
import { Module } from "node:module";
const load = (Module as unknown as {_load: (name: string, ...args: unknown[]) => unknown})._load;
(Module as unknown as {_load: unknown})._load = function(this: unknown, name: string, ...args: unknown[]) {
  return name === "vscode" ? {DiagnosticSeverity: {Error: 0, Warning: 1, Information: 2}} : load.call(this, name, ...args);
};
const {toDiagnosticEntries} = require("../diagnostics") as typeof import("../diagnostics");
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
