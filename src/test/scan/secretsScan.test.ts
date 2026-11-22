import assert from "node:assert/strict";
import {test} from "node:test";
import {scanSecrets} from "../../scan/secretsScan";
test("detects env credentials without returning values", () => {
 const content = "KEYCLOAK_ADMIN_PASSWORD=example-test-password\nKC_DB_PASSWORD=example-db-password\nHOST=localhost";
 const result = scanSecrets(content);
 assert.deepEqual(result.map(x => x.line), [1,2]);
 assert.equal(JSON.stringify(result).includes("example-test-password"), false);
});
test("ignores placeholders and comments", () => {
 assert.deepEqual(scanSecrets("# PASSWORD=not-real\nPASSWORD=${PASSWORD}\nAPI_KEY=changeme\nDB_PASSWORD=\n"), []);
});
test("detects YAML and properties credentials", () => {
 assert.deepEqual(scanSecrets("client_secret: example-client-secret\npassword=sample-password").map(x => x.line), [1,2]);
});

test("does not flag GitHub Actions secret references or env placeholders", () => {
 const content = 'password: ${{ secrets.DATABASE_PASSWORD }}\nclient_secret: "${{ vars.CLIENT_SECRET }}"\napi_key: "${API_KEY}"\npassword: literal-example-value';
 assert.deepEqual(scanSecrets(content).map(x => x.line), [4]);
});
import { scanSecurity } from "../../scan/securityRules";
test("finds hardcoded credentials in code declarations and SQL built by concatenation", () => {
  assert.equal(scanSecrets('const password = "hunter2hunter2";').length, 1);
  assert.equal(scanSecrets('private static final String API_KEY = "abcd1234";').length, 1);
  assert.equal(scanSecrets('const password = process.env.PASSWORD;').length, 0);
  assert.equal(scanSecrets('const password = "changeme";').length, 0);
  assert.equal(scanSecurity("db.js", 'conn.query("SELECT * FROM u WHERE n = \'" + req.query.name + "\'", cb);').length, 1);
  assert.equal(scanSecurity("db.js", 'conn.query("SELECT * FROM u WHERE n = ?", [name], cb);').length, 0);
});

test("credentials in tests, docs, examples and dev profiles are MEDIUM; real config stays HIGH", () => {
  const line = "password=s3cr3t-value-1";
  const sev = (path: string) => scanSecrets(line, path)[0]?.severity;
  assert.equal(sev("src/main/resources/application.properties"), "HIGH");
  assert.equal(sev("src/main/resources/application-dev.properties"), "MEDIUM");
  assert.equal(sev("src/test/resources/application.properties"), "MEDIUM");
  assert.equal(sev("docs/setup.md"), "MEDIUM");
  assert.equal(sev(".env.example"), "MEDIUM");
  assert.equal(sev("app/requests.properties"), "HIGH");
  assert.equal(scanSecrets('private static final String PASSWORD = "s3cr3t-value-1";', "src/LoginServiceTest.java")[0]?.severity, "MEDIUM");
});
test("translations in any non-Latin script are labels, not credentials", () => {
 const i18n = '{\n "LABEL_PASSWORD": "パスワード",\n "MANDATORY_PASSWORD": "请提供密码",\n "LABEL_PRIVATE_KEY": "รหัสผ่าน",\n "PASSWORD_HINT": "پسورد"\n}';
 assert.deepEqual(scanSecrets(i18n, "frontend/src/assets/i18n/ja_JP.json"), []);
 assert.equal(scanSecrets('{\n "password": "s3cr3t-Pässwörd-42"\n}', "config.json").length, 1);
});
