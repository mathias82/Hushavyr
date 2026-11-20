import assert from "node:assert/strict";
import {test} from "node:test";
import {scanSecurity} from "../securityRules";
test("detects insecure TLS and weak crypto",()=>{
 const found=scanSecurity("app.ts","const opts = {rejectUnauthorized: false};\ncreateHash('md5')");
 assert.deepEqual(found.map(x=>x.line),[1,2]);
});
test("detects Java deserialization",()=>{
 assert.equal(scanSecurity("Demo.java","ObjectInputStream input = new ObjectInputStream(socket.getInputStream());").length,1);
});
test("does not claim vulnerabilities in comments or unsupported files",()=>{
 assert.deepEqual(scanSecurity("Demo.java","// Runtime.getRuntime().exec(command)"),[]);
 assert.deepEqual(scanSecurity("notes.txt","rejectUnauthorized: false"),[]);
});
