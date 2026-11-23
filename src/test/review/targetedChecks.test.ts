import { test } from "node:test";
import { strict as assert } from "node:assert";
import { findTriggers, targetedFindings } from "../../review/targetedChecks";

const kinds = (path: string, text: string, extra: {path: string; text: string}[] = []) =>
  findTriggers([{path, text}, ...extra]).map(t => t.kind + "@" + t.line);

test("triggers point at likely misses and stay quiet on the fixed twins", () => {
  assert.deepEqual(kinds("Price.java", "class Price {\n  int total(int price, int qty) {\n    return price * qty;\n  }\n}"), ["overflow@3"]);
  assert.deepEqual(kinds("Price.java", "class Price {\n  long total(int price, int qty) {\n    return (long) price * qty;\n  }\n}"), []);
  assert.deepEqual(kinds("rank.js", "const top = scores.sort();"), ["sort@1"]);
  assert.deepEqual(kinds("rank.js", "const top = scores.sort((a, b) => a - b);"), []);
  assert.deepEqual(kinds("save.ts", "async function save(x: Item): Promise<void> { await db.put(x); }\nexport async function run(x: Item) {\n  save(x);\n  log('saved');\n}"), ["await@3"]);
  assert.deepEqual(kinds("save.ts", "async function save(x: Item): Promise<void> { await db.put(x); }\nexport async function run(x: Item) {\n  await save(x);\n}"), []);
  assert.deepEqual(kinds("page.js", "function page(limit) {\n  const n = limit || 20;\n  return n;\n}"), ["falsy@2"]);
  assert.deepEqual(kinds("page.js", "function page(limit) {\n  const n = limit ?? 20;\n  return n;\n}"), []);
  assert.deepEqual(kinds("Guard.java", "class Guard {\n  int len(String s) {\n    int n = s.length();\n    if (s == null) return 0;\n    return n;\n  }\n}"), ["null-before-guard@3"]);
  assert.deepEqual(kinds("Guard.java", "class Guard {\n  int len(String s) {\n    if (s == null) return 0;\n    return s.length();\n  }\n}"), []);
  const repo = {path: "Repo.java", text: "class Repo {\n  public User find(String id) {\n    if (id.isEmpty()) return null;\n    return new User(id);\n  }\n}"};
  assert.deepEqual(kinds("Svc.java", "class Svc {\n  String name(Repo r, String id) {\n    return r.find(id).getName();\n  }\n}", [repo]), ["cross-file-null@3"]);
  assert.deepEqual(kinds("Svc.java", "class Svc {\n  String name(Repo r, String id) {\n    User u = r.find(id);\n    if (u == null) return \"\";\n    return u.getName();\n  }\n}", [repo]), []);
});

test("a focused yes becomes a finding at the trigger line; a no, invalid JSON or an error adds nothing", async () => {
  const source = [{path: "Price.java", text: "class Price {\n  int total(int price, int qty) {\n    return price * qty;\n  }\n}"}];
  const answer = (raw: string | Error) => ({generate: async () => { if (raw instanceof Error) throw raw; return raw; }});
  const yes = await targetedFindings(answer('{"bug":true}'), source);
  assert.deepEqual(yes.map(f => [f.line, f.title, f.evidence, f.verification]), [[3, "Integer overflow in multiplication", "return price * qty;", "supported"]]);
  for (const raw of ['{"bug":false}', "nope", new Error("down")]) assert.deepEqual(await targetedFindings(answer(raw), source), []);
});
