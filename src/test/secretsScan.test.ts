import assert from "node:assert/strict";
import {test} from "node:test";
import {scanSecrets} from "../secretsScan";
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
