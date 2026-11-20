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

test("does not flag GitHub Actions secret references or env placeholders", () => {
 const content = 'password: ${{ secrets.DATABASE_PASSWORD }}\nclient_secret: "${{ vars.CLIENT_SECRET }}"\napi_key: "${API_KEY}"\npassword: literal-example-value';
 assert.deepEqual(scanSecrets(content).map(x => x.line), [4]);
});
