import {test} from "node:test";
import {strict as assert} from "node:assert";
import {changedRegions, changedSources} from "../../review/changedScope";
import {changedLines} from "../../git/changedFiles";

const JS = ["function inc(x) {", "  return x + 1;", "}", "", "function dbl(x) {", "  const y = x * 2;", "  return y;", "}", "", "const top = 1;", "", "function three() {", "  return 3;", "}"].join("\n");

test("changed lines widen to their enclosing function; top-level lines get a small window; nearby regions merge", () => {
  assert.deepEqual(changedRegions("a.js", JS, new Set([6])), [{start: 5, end: 8}]);
  assert.deepEqual(changedRegions("a.js", JS, new Set([10]), 1), [{start: 9, end: 11}]);
  assert.deepEqual(changedRegions("a.js", JS, new Set([2, 6])), [{start: 1, end: 8}]);
  assert.deepEqual(changedRegions("a.js", JS, new Set([99])), []);
});

test("changed sources: excerpts with real start lines, whole file for new files or when most of it changed", () => {
  assert.deepEqual(changedSources("a.js", JS, new Set([13])), [{path: "a.js", text: "function three() {\n  return 3;\n}", startLine: 12}]);
  assert.deepEqual(changedSources("a.js", JS, "all"), [{path: "a.js", text: JS, startLine: 1}]);
  assert.deepEqual(changedSources("a.js", JS, new Set([2, 6, 13])), [{path: "a.js", text: JS, startLine: 1}]);
  assert.deepEqual(changedSources("a.js", JS, new Set()), []);
});

test("git diff -U0 hunks map to added/changed lines per file", () => {
  const diff = "+++ b/a.js\n@@ -5,0 +6,2 @@\n+x\n+y\n@@ -9 +11 @@\n-z\n+w\n+++ /dev/null\n@@ -1 +0,0 @@\n";
  assert.deepEqual([...changedLines(diff).get("a.js")!], [6, 7, 11]);
});
