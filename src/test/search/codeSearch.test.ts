import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractSymbols, indexSymbols, rankByName, searchByMeaning, searchWithModel, similarity, projectRoot, keepIndent } from "../../search/codeSearch";

const JAVA = `package shop;

public class OrderService {
  private final Repo repo;

  public OrderService(Repo repo) { this.repo = repo; }

  /** Sum of the order lines. */
  public double calculateTotal(Order order) {
    double total = 0;
    for (Line l : order.lines()) {
      total += l.price() * l.qty();
    }
    return total;
  }

  private void log(String s) {
    System.out.println("{" + s);
  }
}
`;

test("extractSymbols finds Java classes, constructors and methods with their line ranges", () => {
  const symbols = extractSymbols("src/OrderService.java", JAVA).map(s => [s.kind, s.container, s.name, s.line, s.endLine]);
  assert.deepEqual(symbols, [["class", "", "OrderService", 3, 20], ["function", "OrderService", "OrderService", 6, 6],
    ["function", "OrderService", "calculateTotal", 9, 15], ["function", "OrderService", "log", 17, 19]]);
});

test("extractSymbols handles Python, Go, TypeScript and C#", () => {
  const py = extractSymbols("a.py", "class Cart:\n    def total(self):\n        return 1\n\n    def add(self, x):\n        self.x = x\n\ndef helper():\n    pass\n");
  assert.deepEqual(py.map(s => [s.container, s.name, s.line, s.endLine]), [["", "Cart", 1, 6], ["Cart", "total", 2, 3], ["Cart", "add", 5, 6], ["", "helper", 8, 9]]);
  const go = extractSymbols("a.go", "package x\n\ntype Store struct {\n  m map[string]int\n}\n\nfunc (s *Store) Get(k string) int {\n  return s.m[k]\n}\n");
  assert.deepEqual(go.map(s => [s.container, s.name, s.line, s.endLine]), [["", "Store", 3, 5], ["Store", "Get", 7, 9]]);
  const ts = extractSymbols("a.ts", "export class Api {\n  async fetchUser(id: string): Promise<User> {\n    if (id) {\n      return get(id);\n    }\n  }\n}\nexport const toCents = (x: number) => {\n  return x * 100;\n};\n");
  assert.deepEqual(ts.map(s => [s.container, s.name, s.line, s.endLine]), [["", "Api", 1, 7], ["Api", "fetchUser", 2, 6], ["", "toCents", 8, 10]]);
  const cs = extractSymbols("a.cs", "public class Bank\n{\n    public async Task<decimal> GetBalance(int id)\n    {\n        return await db.Sum(id);\n    }\n}\n");
  assert.deepEqual(cs.map(s => [s.container, s.name, s.line, s.endLine]), [["", "Bank", 1, 7], ["Bank", "GetBalance", 3, 6]]);
});

test("extractSymbols ignores braces in parameter lists that span lines", () => {
  const ts = extractSymbols("a.ts", "export async function run(\n  a: string,\n  options: {x?: number} = {}\n): Promise<void> {\n  go(a);\n}\n");
  assert.deepEqual(ts.map(s => [s.name, s.line, s.endLine]), [["run", 1, 6]]);
  const typed = extractSymbols("b.ts", "class A {\n  read(x: string): Promise<{abs: string}> {\n    return go(x);\n  }\n  run() {\n    rmSync(dir, {recursive: true});\n    write(a,\n      {b: 1});\n  }\n}\n");
  assert.deepEqual(typed.map(s => [s.name, s.line, s.endLine]), [["A", 1, 10], ["read", 2, 4], ["run", 5, 9]]);
});

test("extractSymbols does not take calls, control flow or comments for declarations", () => {
  const names = extractSymbols("a.java", "class A {\n  void run() {\n    if (x) { go(); }\n    foo(bar);\n    // void fake() {\n    return compute(1);\n  }\n}\n").map(s => s.name);
  assert.deepEqual(names, ["A", "run"]);
});

test("rankByName tolerates typos, spaces and Class.method", () => {
  const symbols = extractSymbols("src/OrderService.java", JAVA);
  assert.ok(similarity("order servce", "OrderService") >= 0.9);
  assert.equal(rankByName(symbols, "order servce")[0].name, "OrderService");
  assert.equal(rankByName(symbols, "order servce")[0].kind, "class");
  const method = rankByName(symbols, "OrderService.calculateTotal")[0];
  assert.deepEqual([method.container, method.name, method.line], ["OrderService", "calculateTotal", 9]);
  assert.equal(rankByName(symbols, "ordrservice calculatetotl")[0].name, "calculateTotal");
  assert.equal(rankByName(symbols, "calcTotal")[0].name, "calculateTotal");
  assert.deepEqual(rankByName(symbols, "PaymentGateway"), []);
});

test("searchWithModel greps the words the model proposes and returns its pick", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hush-search-"));
  try {
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, "src", "OrderService.java"), JAVA);
    await writeFile(join(dir, "src", "Mailer.java"), "class Mailer {\n  void send(String to) {\n    smtp.send(to);\n  }\n}\n");
    const project = await indexSymbols(dir);
    const prompts: string[] = [];
    const answers = [JSON.stringify({words: ["total", "price"]}), JSON.stringify({pick: [1]})];
    const model = {generate: async (prompt: string) => { prompts.push(prompt); return answers.shift()!; }};
    const hits = await searchWithModel(model, project, "the method that adds up the order price");
    assert.equal(hits[0].name, "calculateTotal");
    assert.match(prompts[1], /calculateTotal/);
    assert.doesNotMatch(prompts[1], /Mailer/);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test("searchByMeaning indexes once, re-embeds only changed files and ranks by cosine", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hush-meaning-"));
  try {
    await writeFile(join(dir, "Mailer.java"), "class Mailer {\n  void send(String to) {\n    smtp.send(to);\n  }\n}\n");
    await writeFile(join(dir, "Tax.java"), "class Tax {\n  double vat(double x) {\n    return x * 0.24;\n  }\n}\n");
    const vec = (text: string): number[] => [/smtp|mail|email/i.test(text) ? 1 : 0, /vat|tax/i.test(text) ? 1 : 0, 0.1];
    let embedded = 0;
    const embedder = {embed: async (texts: string[]) => { embedded += texts.length; return texts.map(vec); }};
    let saved: string | undefined;
    const store = {load: async () => saved, save: async (text: string) => { saved = text; }};
    const project = await indexSymbols(dir);
    const first = await searchByMeaning(embedder, "nomic-embed-text", project, "where do we compute tax", store);
    assert.equal(first[0].container + "." + first[0].name, "Tax.vat");
    const afterFirst = embedded;
    await searchByMeaning(embedder, "nomic-embed-text", project, "send an email", store);
    assert.equal(embedded, afterFirst + 1, "only the query is embedded when nothing changed");
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test("projectRoot finds the git root from a subfolder", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hush-root-"));
  try {
    await mkdir(join(dir, ".git"));
    await mkdir(join(dir, "a", "b"), {recursive: true});
    assert.equal(await projectRoot(join(dir, "a", "b")), dir);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test("keepIndent restores indentation the model dropped from a method", () => {
  const original = "  public int f() {\n    return 1;\n  }";
  assert.equal(keepIndent(original, "public int f() {\n    return 2;\n  }"), "  public int f() {\n    return 2;\n  }");
  assert.equal(keepIndent(original, "public int f() {\n  return 2;\n}"), "  public int f() {\n    return 2;\n  }");
  assert.equal(keepIndent(original, "  public int f() {\n    return 2;\n  }"), "  public int f() {\n    return 2;\n  }");
});

test("keepIndent: lines the model put before the method get the method's indentation", () => {
  assert.equal(keepIndent("  void f() {\n    g();\n  }", "// note\nvoid f() {\n    g();\n  }"), "  // note\n  void f() {\n    g();\n  }");
});

test("similarity forgives swapped letters", () => {
  assert.ok(similarity("crat", "cart") >= 0.85);
  assert.ok(similarity("calcualte", "calculate") >= 0.9);
  assert.ok(similarity("cart", "card") < 0.8);
});
