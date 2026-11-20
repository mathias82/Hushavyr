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
