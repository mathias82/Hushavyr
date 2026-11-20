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
