import { test } from "node:test";
import { strict as assert } from "node:assert";
import { parseTrivyVulnerabilities } from "../dependencyAudit";
test("lists CVEs worst-first with fixed versions and sanitized text", () => {
  const result = parseTrivyVulnerabilities({Results: [{Target: "pom.xml", Vulnerabilities: [
    {VulnerabilityID: "CVE-2024-0002", PkgName: "a", InstalledVersion: "1.0", Severity: "LOW", Title: "low"},
    {VulnerabilityID: "CVE-2024-0001", PkgName: "b", InstalledVersion: "2.0", FixedVersion: "2.1", Severity: "CRITICAL", Title: "bad\n[x](y)\u0000"},
    {PkgName: "no id"}
  ]}, {Target: "empty"}]});
  assert.deepEqual(result.map(v => v.id), ["CVE-2024-0001", "CVE-2024-0002"]);
  assert.equal(result[0].fixed, "2.1");
  assert.equal(result[1].fixed, undefined);
  assert.doesNotMatch(result[0].title, /[\n\u0000]/);
  assert.deepEqual(parseTrivyVulnerabilities(null), []);
});
import { groupVulnerabilities, findDependencyLine } from "../dependencyAudit";
test("groups the same CVE across manifests into one row", () => {
  const v = {id: "CVE-2026-1", pkg: "g:a", installed: "1", severity: "MEDIUM", title: "", target: "pom.xml"};
  const groups = groupVulnerabilities([v, {...v}, {...v, target: "mod/pom.xml"}, {...v, installed: "2"}]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].targets, ["pom.xml", "mod/pom.xml"]);
});
test("finds the declaration line per manifest type, falling back to line 1", () => {
  assert.equal(findDependencyLine("<project>\n<dependency>\n <artifactId>opentelemetry-api</artifactId>\n", "io.opentelemetry:opentelemetry-api"), 3);
  assert.equal(findDependencyLine('{\n "dependencies": {\n  "lodash": "4.0.0"\n }\n}', "lodash"), 3);
  assert.equal(findDependencyLine("flask==1.0\nrequests>=2", "requests"), 2);
  assert.equal(findDependencyLine("<project/>", "g:inherited"), 1);
});
test("finds version properties that pin an inherited dependency", () => {
  assert.equal(findDependencyLine("<properties>\n <java>21</java>\n <opentelemetry.version>1.62.0</opentelemetry.version>\n</properties>", "io.opentelemetry:opentelemetry-api", "1.62.0"), 3);
});
import {bumpVersion, firstFixedVersion, parseMarkerMessage} from "../dependencyAudit";
import {relatedScriptSources, localImportSpecifiers} from "../relatedJava";
import {tr} from "../i18n";
import {mkdtemp, mkdir, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";

test("bumps only the exact installed version on a line", () => {
  assert.equal(bumpVersion("<otel.version>1.62.0</otel.version>", "1.62.0", "1.67.0"), "<otel.version>1.67.0</otel.version>");
  assert.equal(bumpVersion("<v>11.62.0</v>", "1.62.0", "1.67.0"), undefined);
  assert.equal(bumpVersion("<artifactId>x</artifactId>", "1.62.0", "1.67.0"), undefined);
});

test("prefers a fixed version in the installed major line", () => {
  assert.equal(firstFixedVersion("2.0.1, 1.9.5", "1.4.0"), "1.9.5");
  assert.equal(firstFixedVersion("no fix", "1.0.0"), undefined);
});

test("reads fix data back from marker messages", () => {
  assert.deepEqual(parseMarkerMessage("CVE-2026-1 in io.x:y 1.0.0 (HIGH). Fixed in 1.1.0, 2.0.0."),
    {id: "CVE-2026-1", pkg: "io.x:y", installed: "1.0.0", fixed: "1.1.0, 2.0.0"});
  assert.equal(parseMarkerMessage("CVE-2026-1 in io.x:y 1.0.0 (HIGH). No fix available."), undefined);
});

test("translates to Greek and falls back to English", () => {
  assert.equal(tr("el", "noFix"), "δεν υπάρχει διόρθωση");
  assert.equal(tr("fr", "noFix"), "no fix available");
});

test("follows relative imports in TypeScript and Python without leaving the project", async () => {
  const root = await mkdtemp(join(tmpdir(), "hv-"));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "a.ts"), 'import {b} from "./b";\nimport x from "../../outside";\n');
  await writeFile(join(root, "src", "b.ts"), "export const b = 1;\n");
  await writeFile(join(root, "src", "m.py"), "from .helper import f\n");
  await writeFile(join(root, "src", "helper.py"), "def f(): pass\n");
  const ts = await relatedScriptSources(root, {path: pathToFileURL(join(root, "src", "a.ts")).toString(), text: 'import {b} from "./b";\nimport x from "../../outside";\n'});
  assert.deepEqual(ts.map(s => s.path), ["src/b.ts"]);
  const py = await relatedScriptSources(root, {path: pathToFileURL(join(root, "src", "m.py")).toString(), text: "from .helper import f\n"});
  assert.deepEqual(py.map(s => s.path), ["src/helper.py"]);
  assert.deepEqual(localImportSpecifiers("a.ts", "const a = require('./x');"), ["./x"]);
});
import {dbAgeDays} from "../dependencyAudit";
test("computes vulnerability database age in whole days", () => {
  const now = Date.parse("2026-11-21T00:00:00Z");
  assert.equal(dbAgeDays('{"UpdatedAt":"2026-11-10T00:00:00Z"}', now), 11);
  assert.equal(dbAgeDays("not json", now), undefined);
});
