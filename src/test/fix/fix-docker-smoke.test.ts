import {test} from "node:test";
import {strict as assert} from "node:assert";
import {execFileSync} from "node:child_process";
import {mkdtemp, mkdir, readFile, writeFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, resolve, dirname} from "node:path";
import {FixSandbox} from "../../fix/fixSandbox";
import {runFixProof} from "../../fix/fixProof";

test("opt-in real Docker red/green smoke preserves sources and verifies offline readonly execution",
  {skip: process.env.AI_PRIVACY_DOCKER_SMOKE !== "1", timeout: 600000}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "local-proof-smoke-"));
  const project = join(directory, "project");
  let box: FixSandbox | undefined;
  try {
    await mkdir(project);
    for (const path of ["pom.xml", "src/main/java/demo/Price.java", "src/test/java/demo/PriceTest.java"]) {
      const target = join(project, path); await mkdir(dirname(target), {recursive: true});
      await writeFile(target, await readFile(resolve(__dirname, "../../../fixtures/java-fix", path)));
    }
    const git = (args: string[]) => execFileSync("git", args, {cwd: project, stdio: "ignore"});
    git(["init", "--initial-branch=main"]);
    git(["config", "user.name", "Fixture"]); git(["config", "user.email", "fixture@example.test"]);
    git(["config", "commit.gpgsign", "false"]); git(["add", "."]); git(["commit", "-m", "Seed public fixture"]);
    const file = join(project, "src/main/java/demo/Price.java"), before = await readFile(file, "utf8");
    box = await FixSandbox.create({project, selected: [file], storage: join(directory, "runs"),
      image: process.env.AI_PRIVACY_MAVEN_IMAGE ?? "maven:3.9-eclipse-temurin-21", signal: new AbortController().signal});
    const sandbox = box, simpleName = sandbox.context.testClass.split(".").at(-1)!;
    const regression = "package demo;\n" +
      "import org.junit.Test;\nimport static org.junit.Assert.*;\n" +
      "public class " + simpleName + " {\n" +
      "@Test public void largeOrder() { assertEquals(5000000000L, new Price().total(50000, 100000)); }\n" +
      "@Test public void readonlyAndOffline() throws Exception {\n" +
      "assertFalse(java.nio.file.Files.isWritable(java.nio.file.Path.of(\"/work/src/main/java/demo/Price.java\")));\n" +
      "java.util.Enumeration<java.net.NetworkInterface> interfaces = java.net.NetworkInterface.getNetworkInterfaces();\n" +
      "while(interfaces.hasMoreElements()) { java.net.NetworkInterface n = interfaces.nextElement(); assertTrue(!n.isUp() || n.isLoopback()); }\n" +
      "}\n}\n";
    const receipt = await runFixProof(sandbox.context, {
      cancelled: () => false, run: (stage, target) => sandbox.run(stage, target),
      proposeTest: async () => regression, approveTest: async () => true, writeTest: source => sandbox.writeTest(source),
      proposeFix: async () => [{path: "src/main/java/demo/Price.java", content: before.replace("return units * cents;", "return (long) units * cents;")}],
      approveFix: async () => true, applyFix: changes => sandbox.applyFix(changes)
    });
    assert.equal(receipt.status, "verified", JSON.stringify(receipt));
    const artifacts = await sandbox.save(receipt);
    const record = JSON.parse(await readFile(join(artifacts, "receipt.json"), "utf8"));
    assert.match(record.patchHash, /^[a-f0-9]{64}$/);
    const patch = await readFile(join(artifacts, "verified.patch"), "utf8");
    assert.match(patch, /return \(long\) units \* cents/);
    git(["apply", "--check", join(artifacts, "verified.patch")]);
    assert.equal(await readFile(file, "utf8"), before);
  } finally {
    if (box) await box.dispose();
    await rm(directory, {recursive: true, force: true});
  }
});
