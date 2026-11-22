import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { indexSymbols } from "../../search/codeSearch";
import { CodeFinder, identifierMentions, isProjectQuestion, projectOverview } from "../../search/projectContext";

test("isProjectQuestion: questions about the whole project, in English and Greek, not about one bug", () => {
  for (const q of ["describe the project", "what does this app do?", "explain the architecture", "περίγραψε το project", "τι κάνει η εφαρμογή;"]) assert.ok(isProjectQuestion(q), q);
  for (const q of ["why is total wrong?", "fix the null check in Mailer"]) assert.ok(!isProjectQuestion(q), q);
});

test("identifierMentions picks code names out of a question", () => {
  assert.deepEqual(identifierMentions("why does OrderService.place() call `send` and calculate_total?").sort(), ["OrderService.place", "calculate_total", "send"].sort());
  assert.deepEqual(identifierMentions("why is the total wrong?"), []);
});

test("projectOverview and CodeFinder read the README, the build file and the types of the given folder", async () => {
  const root = await mkdtemp(join(tmpdir(), "hush-proj-"));
  await mkdir(join(root, "src", "shop"), {recursive: true});
  await writeFile(join(root, "README.md"), "# Shop\nSells books.\n");
  await writeFile(join(root, "pom.xml"), "<project><artifactId>shop</artifactId></project>\n");
  await writeFile(join(root, "src", "shop", "Cart.java"), "package shop;\npublic class Cart {\n  public int size() {\n    return 0;\n  }\n}\n");
  const overview = await projectOverview(await indexSymbols(root));
  for (const part of ["Sells books.", "pom.xml", "Java", "Cart"]) assert.ok(overview.includes(part), part);
  const hits = await new CodeFinder({root, indexDir: join(root, "..", "idx")}).find("crat size");
  assert.equal(hits[0]?.name, "size");
  assert.equal(hits[0]?.container, "Cart");
});
