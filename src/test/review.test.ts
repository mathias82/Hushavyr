import { test } from "node:test";
import { strict as assert } from "node:assert";
import { validateReview, formatReview, reviewPrompt, inlineText, fenceLanguage, salvageFindings} from "../review";
const source = 'return Response.status(404).entity("{\\"error\\":\\"" + e.getTenantId() + "\\"}").build();';
function finding(title:string,evidence:string) { return {title,severity:"high",evidence,fix:"Use a JSON DTO",regressionTest:"Test tenant ID with a quote"}; }
test("rejects SQL injection claim without SQL sink", () => {
  const result = validateReview(JSON.stringify({findings:[finding("SQL Injection",source)]}),source);
  assert.equal(result.findings.length,0);assert.equal(result.rejected,1);
});
test("keeps SQL injection claim when the query string is SELECT *", () => {
  const js = `db.query("SELECT * FROM books WHERE author = '" + author + "'", cb);`;
  const result = validateReview(JSON.stringify({findings:[finding("SQL Injection",js)]}),js);
  assert.equal(result.findings.length,1);
});
test("rejects a mutable default claim only when no def has a mutable default", () => {
  const guarded = {path: "events.py", text: "def add_event(event, events=None):\n    if events is None:\n        events = []\n    events.append(event)"};
  const shared = {path: "events.py", text: "def add_event(event,\n              events=[]):\n    events.append(event)"};
  const claim = (src: {path: string; text: string}) => validateReview(JSON.stringify({findings: [finding("Mutable default argument", "events.append(event)")]}), [src]);
  assert.equal(claim(guarded).findings.length, 0);
  assert.equal(claim(shared).findings.length, 1);
});
test("rejects a YAML deserialization claim when only yaml.safe_load is used", () => {
  const claim = (text: string) => validateReview(JSON.stringify({findings: [finding("Unsafe YAML deserialization", "return yaml" + text.split("return yaml")[1])]}), [{path: "config.py", text}]);
  assert.equal(claim("import yaml\ndef load(text):\n    return yaml.safe_load(text)").findings.length, 0);
  assert.equal(claim("import yaml\ndef load(text):\n    return yaml.load(text)").findings.length, 1);
});
test("rejects fabricated evidence", () => {
  const result = validateReview(JSON.stringify({findings:[finding("JSON escaping","this code does not exist")]}),source);
  assert.equal(result.findings.length,0);
});
test("keeps source-grounded finding as potential only", () => {
  const result = validateReview(JSON.stringify({findings:[finding("Unsafe JSON string concatenation",source)]}),source);
  assert.equal(result.findings.length,1);assert.equal(result.findings[0].status,"potential");
  assert.match(formatReview(result),/not confirmed/);
});
test("handles malformed JSON safely",()=>assert.match(formatReview(validateReview("invalid",source)),/not verified/));
test("review prompt requires source evidence",()=>assert.match(reviewPrompt("review",source),/exact verbatim substring/));

test("review prompt covers language-specific correctness",()=>{
 const files=[{path:"main.go",text:"func f() error { return nil }"},{path:"worker.rs",text:"fn main() {}"},{path:"handler.py",text:"def run(x): return x"}];
 const prompt=reviewPrompt("review correctness",files);
 for(const term of ["Java/Kotlin","JavaScript/TypeScript","Python","Go ignored errors","Rust Result/Option","C/C++","C#","SQL joins","shell quoting"])assert.ok(prompt.includes(term),term);
 for(const file of files)assert.ok(prompt.includes(file.path));
 assert.match(prompt,/A clean review is allowed/);
});
import { asksForExplanation} from "../review";
test("explanation requests are not treated as bug reviews", () => {
  assert.equal(asksForExplanation("explain me the code"), true);
  assert.equal(asksForExplanation("τι κάνει αυτός ο κώδικας;"), true);
  assert.equal(asksForExplanation("explain and find bugs"), false);
  assert.equal(asksForExplanation("can you check code?"), false);
});
test("review location is shown relative to the workspace, not as a file URI", () => {
  const js = `db.query("SELECT * FROM books WHERE author = '" + author + "'", cb);`;
  const result = validateReview(JSON.stringify({findings:[{...finding("SQL Injection",js), path:"file:///home/dev/shop/src/books.js"}]}),[{path:"file:///home/dev/shop/src/books.js",text:js}]);
  const text = formatReview(result, p => p.replace("file:///home/dev/shop/", ""));
  assert.match(text, /\*\*Location:\*\* .src\/books\.js:1./);
  assert.doesNotMatch(text, /file:/);
});

test("model text keeps comparison operators visible in Markdown", () => {
  assert.equal(inlineText("change i <= n to i < n, not <b>"), "change i &lt;= n to i &lt; n, not &lt;b&gt;");
});
test("evidence fence follows the file language", () => {
  assert.deepEqual([fenceLanguage("src/books.js"), fenceLanguage("app.PY"), fenceLanguage("A.java"), fenceLanguage(undefined), fenceLanguage("x.unknown")], ["javascript", "python", "java", "", ""]);
});

test("a review cut off by the token limit keeps its complete findings and the finished fields of the last one", () => {
  const source = {path: "A.java", text: "class A {\n  String name(String s) {\n    return s.trim();\n  }\n}"};
  const finding = '{"title":"Null dereference of s","severity":"high","startLine":3,"endLine":3,"fix":"Check s for null","regressionTest":"name(null)","path":"A.java"}';
  const cut = '{"findings":[' + finding + ',{"title":"Second","severity":"low","startLine":3,"endLine":3,"fix":"x","path":"A.java","regressionTest":"assert a;\\nassert a;\\nass';
  assert.equal(salvageFindings(cut)?.findings.length, 2);
  assert.deepEqual((salvageFindings(cut)?.findings[1] as {title: string}).title, "Second");
  const result = validateReview(cut, [source]);
  assert.equal(result.error, undefined);
  assert.ok(result.findings.some(f => f.title === "Null dereference of s"));
  assert.equal(salvageFindings('{"findings":[{"title":"x'), undefined);
});
