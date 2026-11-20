import {test} from "node:test";
import assert from "node:assert/strict";
import {parseScannerOutput,runScanner} from "../externalScanners";
test("Semgrep parses locations without exposing source snippets",()=>{
 const output=JSON.stringify({results:[{check_id:"local.rule",path:"src/a.ts",start:{line:7},extra:{severity:"WARNING",lines:"SECRET"}}]});
 assert.deepEqual(parseScannerOutput("semgrep",output,"/repo"),[{tool:"semgrep",rule:"local.rule",severity:"WARNING",path:"src/a.ts",line:7}]);
 assert.doesNotMatch(JSON.stringify(parseScannerOutput("semgrep",output,"/repo")),/SECRET/);
});
test("Gitleaks excludes secrets and traversal paths",()=>{
 const output=JSON.stringify([{RuleID:"generic",File:"src/a.env",StartLine:3,Secret:"PRIVATE"},{RuleID:"other",File:"../outside",StartLine:1}]);
 const findings=parseScannerOutput("gitleaks",output,"/repo");
 assert.equal(findings.length,1);
 assert.equal(findings[0].line,3);
 assert.doesNotMatch(JSON.stringify(findings),/PRIVATE/);
});

test("missing bundled Semgrep rules fail safely before invoking CLI",async()=>{
 const result=await runScanner("semgrep",process.cwd(),"/nonexistent/hushavyr-rules.yml");
 assert.equal(result.status,"failed");
 assert.equal(result.reason,"rules-missing");
 assert.deepEqual(result.findings,[]);
});
test("bundled rules cover Java JavaScript TypeScript and Python",()=>{
 const {readFileSync}=require("node:fs") as typeof import("node:fs");
 const {join}=require("node:path") as typeof import("node:path");
 const yaml=readFileSync(join(__dirname,"../../rules/hushavyr-review.yml"),"utf8");
 for(const language of ["java","javascript","typescript","python"])assert.match(yaml,new RegExp(language));
 assert.match(yaml,/hushavyr.java-sql-concatenation/);
 assert.match(yaml,/InsecureTrustManagerFactory/);
});
