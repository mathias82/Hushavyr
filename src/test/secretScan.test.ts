import assert from "node:assert/strict";
import {test} from "node:test";
import {scanSecrets} from "../secretScan";
test("flags hardcoded env passwords without disclosing values", () => {
  const findings = scanSecrets("keycloak.env", "KEYCLOAK_ADMIN_PASSWORD=sample-secret\nKC_DB_PASSWORD=another-secret\n");
  assert.equal(findings.length, 2);
  assert.deepEqual(findings.map(f => f.line), [1, 2]);
  assert.ok(!JSON.stringify(findings).includes("sample-secret"));
});
test("ignores placeholders, comments and empty credentials", () => {
  assert.deepEqual(scanSecrets(".env", "# TOKEN=actual\nPASSWORD=\nAPI_KEY=\${API_KEY}\nSECRET=changeme"), []);
});
test("supports YAML and properties", () => {
  assert.equal(scanSecrets("application.yml", "client_secret: actual-value\n").length, 1);
  assert.equal(scanSecrets("app.properties", "db.password=actual-value\n").length, 1);
});
