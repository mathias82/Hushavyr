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
import {relatedScriptSources, localImportSpecifiers} from "../review/relatedJava";
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
import {findingFix, fixWindow, parseReviewMessage, parseReplacement, isPlausibleFix, fitFix} from "../fixEdit";
import {parseChangedFiles} from "../changedFiles";
test("fix window stays inside the file", () => {
  assert.deepEqual(fixWindow(100, 0), {start: 0, end: 6});
  assert.deepEqual(fixWindow(5, 4), {start: 1, end: 4});
});
test("reads title and fix from review markers and rejects bad replacements", () => {
  assert.deepEqual(parseReviewMessage("Potential: NPE on null\nFix: add a check\nTest: x"), {title: "NPE on null", fix: "add a check"});
  assert.equal(parseReviewMessage("CVE-1 in a 1 (HIGH). Fixed in 2."), undefined);
  assert.equal(parseReplacement('{"replacement":""}'), undefined);
  assert.equal(parseReplacement("nope"), undefined);
  assert.equal(parseReplacement('{"replacement":"a\\nb\\n"}'), "a\nb");
  assert.equal(isPlausibleFix(["a"], "a"), false);
  assert.equal(isPlausibleFix(["a"], "b"), true);
  // A real qwen2.5-coder:14b answer returned only the fixed line for a 9-line excerpt.
  const excerpt = ["", "app.get(\"/books\", (req, res) => {", "  const id = req.query.id;", "  db.query(\"SELECT * FROM books WHERE id = \" + id, cb);", "});", "", "const adminPassword = \"x\";", "app.listen(3000);", ""];
  const fixed = "  db.query(\"SELECT * FROM books WHERE id = ?\", [id], cb);";
  assert.equal(isPlausibleFix(excerpt, fixed), false, "dropping the unrelated lines would delete code");
  assert.deepEqual(fitFix(excerpt, fixed, 3), {start: 3, end: 3, text: fixed}, "a lone corrected line replaces only the marked line");
  assert.deepEqual(fitFix(excerpt, fixed.trim(), 3), {start: 3, end: 3, text: fixed}, "a lone line keeps the original indentation");
  const whole = excerpt.join("\n").replace("= \" + id, cb", "= ?\", [id], cb");
  assert.deepEqual(fitFix(excerpt, whole, 3), {start: 0, end: 8, text: whole});
  assert.equal(fitFix(excerpt, "app.listen(3000);", 3), undefined, "a line unrelated to the marked one is refused");
});
test("changed file list drops traversal, lockfiles and build output", () => {
  assert.deepEqual(parseChangedFiles("src/a.ts\n../x.ts\n/etc/p.py\npackage-lock.json\nnode_modules/q/i.js\ndist/b.js\nREADME.md\nsrc/B.java"), ["src/a.ts", "src/B.java"]);
});

import {auditDependencies} from "../dependencyAudit";
import {mkdtempSync, mkdirSync, writeFileSync} from "node:fs";
import {join as joinPath} from "node:path";
test("manifests in direct subfolders are detected and a bare package.json gets a lockfile hint", async () => {
  const bare = mkdtempSync(joinPath(tmpdir(), "hush-deps-"));
  writeFileSync(joinPath(bare, "package.json"), "{}");
  const none = await auditDependencies(bare);
  assert.equal(none.status, "unsupported");
  assert.match(none.note, /package-lock-only/);
  mkdirSync(joinPath(bare, "api"));
  writeFileSync(joinPath(bare, "api", "requirements.txt"), "flask==0.12\n");
  const nested = await auditDependencies(bare);
  assert.equal(nested.manager, "pip");
  assert.match(nested.note, /package-lock-only/);
});

import {dbAgeHours, dbIsStale, formatDbAge} from "../dependencyAudit";
import {osvDbAgeHours} from "../codeScanners";
test("CVE database age uses the download time and flags anything over a day as stale", async () => {
  const now = Date.parse("2026-11-21T12:00:00Z");
  assert.equal(dbAgeHours(JSON.stringify({UpdatedAt: "2026-11-01T00:00:00Z", DownloadedAt: "2026-11-21T09:30:00Z"}), now), 2);
  assert.equal(dbAgeHours("{}", now), undefined);
  assert.deepEqual([formatDbAge(5), formatDbAge(72), formatDbAge(undefined)], ["5 h ago", "3 days ago", "not downloaded"]);
  assert.deepEqual([dbIsStale(24), dbIsStale(25), dbIsStale(undefined)], [false, true, true]);
  const dir = await mkdtemp(join(tmpdir(), "osvdb-"));
  assert.equal(await osvDbAgeHours([dir]), undefined);
  await mkdir(join(dir, "npm"));
  await writeFile(join(dir, "npm", "all.zip"), "x");
  assert.equal(await osvDbAgeHours([dir], Date.now() + 3.5 * 3_600_000), 3);
});

test("findingFix gives scanner, data-flow and secret findings a fix by kind; dependency CVEs are left to the upgrade quick fix", () => {
  assert.match(findingFix("HIGH · SQL injection: request input reaches this sink · sink src/books.js:9 · input src/books.js:8")!.fix, /parameterized query/);
  assert.equal(findingFix("HIGH · SQL injection: request input reaches this sink · sink src/books.js:9 · input src/books.js:8")!.title, "SQL injection: request input reaches this sink");
  assert.match(findingFix("MEDIUM · Open redirect: request input reaches this sink")!.fix, /relative path/);
  assert.match(findingFix("Potential hardcoded credential (AWS key); value redacted")!.fix, /environment variable/);
  assert.equal(findingFix("Null check\nFix: guard the value")!.fix, "guard the value");
  assert.equal(findingFix("CVE-2018-1000656 in flask 0.12.2 (HIGH). Fixed in 0.12.3."), undefined);
});

test("dependency fix: exact command for direct and transitive packages", async () => {
  const {dependencyFix, isDirectDependency, manifestFor} = await import("../dependencyAudit");
  assert.equal(manifestFor("web/package-lock.json"), "web/package.json");
  assert.equal(manifestFor("go.sum"), "go.mod");
  const pkg = "{\n  \"dependencies\": {\"lodash\": \"^4.17.20\"}\n}";
  assert.ok(isDirectDependency(pkg, "lodash"));
  assert.ok(!isDirectDependency(pkg, "minimist"));
  assert.ok(!isDirectDependency("require (\n\tgolang.org/x/net v0.1.0 // indirect\n)", "golang.org/x/net"));
  assert.match(dependencyFix("package-lock.json", "lodash", "4.17.20", "4.17.21", true)!, /npm install lodash@4\.17\.21/);
  assert.match(dependencyFix("package-lock.json", "minimist", "1.2.5", "1.2.6", false)!, /overrides/);
  assert.match(dependencyFix("go.sum", "golang.org/x/net", "v0.1.0", "0.17.0", false)!, /go get golang\.org\/x\/net@v0\.17\.0/);
  assert.match(dependencyFix("pom.xml", "org.yaml:snakeyaml", "1.33", "2.0", true)!, /<version>2\.0<\/version>/);
  assert.equal(dependencyFix("package-lock.json", "lodash", "4.17.20", undefined, true), undefined);
});

test("reads a dependency CVE back from markers, CLI lines and chat rows", async () => {
  const {parseDependencyFinding} = await import("../dependencyAudit");
  const expected = {id: "CVE-2021-23337", pkg: "lodash", installed: "4.17.20", fixed: "4.17.21"};
  assert.deepEqual(parseDependencyFinding("CVE-2021-23337 in lodash 4.17.20 (HIGH). Fixed in 4.17.21."), expected);
  assert.deepEqual(parseDependencyFinding("CVE-2021-23337 in lodash 4.17.20, fixed in 4.17.21: Command injection"), expected);
  assert.deepEqual(parseDependencyFinding("HIGH · CVE-2021-23337 lodash 4.17.20 · fixed in 4.17.21 · package-lock.json:12"), expected);
  assert.deepEqual(parseDependencyFinding("HIGH · CVE-2021-23337 · lodash 4.17.20 · διορθώνεται στο 4.17.21 · σε package-lock.json:12"), expected);
  assert.equal(parseDependencyFinding("CVE-2021-23337 in lodash 4.17.20 (HIGH). No fix available.")?.fixed, undefined);
  assert.equal(parseDependencyFinding("SQL injection: user input reaches query"), undefined);
});

test("plans a dependency upgrade: deterministic bump when direct, model edit otherwise", async () => {
  const {acceptManifestEdit, planDependencyFix} = await import("../dependencyAudit");
  const pkg = "{\n  \"dependencies\": {\n    \"lodash\": \"4.17.20\"\n  }\n}\n";
  const direct = planDependencyFix("app/package-lock.json", {id: "CVE-1", pkg: "lodash", installed: "4.17.20", fixed: "4.17.21"}, pkg, "app/package.json")!;
  assert.equal(direct.manifest, "app/package.json");
  assert.equal(direct.then, "npm install");
  assert.equal(direct.updated, pkg.replace("4.17.20", "4.17.21"));
  const minimist = {id: "CVE-2", pkg: "minimist", installed: "1.2.5", fixed: "1.2.6"};
  const transitive = planDependencyFix("app/package-lock.json", minimist, pkg, "app/package.json")!;
  assert.equal(transitive.updated, undefined);
  assert.match(transitive.advice, /overrides/);
  assert.equal(planDependencyFix("package-lock.json", {id: "CVE-3", pkg: "x", installed: "1.0.0"}, pkg), undefined);
  const edited = pkg.replace("}\n}", "},\n  \"overrides\": {\"minimist\": \"1.2.6\"}\n}");
  assert.ok(acceptManifestEdit("package.json", pkg, edited, minimist));
  assert.ok(!acceptManifestEdit("package.json", pkg, edited.replace("},\n  \"overrides\"", "}\n  \"overrides\""), minimist), "invalid JSON");
  assert.ok(!acceptManifestEdit("package.json", pkg, pkg, minimist), "no change");
});
