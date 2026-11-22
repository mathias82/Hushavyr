import {test} from "node:test";
import {strict as assert} from "node:assert";
import {dockerCreateArgs, makePatch, safeRelative, validateFixChanges} from "../../fix/fixSandbox";
import {parseTestProposal, parseFixProposal} from "../../fix/fixProposals";
const input = {snapshot: "/private/snapshot", target: "/private/build", cache: "/private/m2/repository",
  project: "module", image: "sha256:" + "a".repeat(64), uid: 1000, gid: 1000,
  name: "ai-privacy-fix-00000000-0000-0000-0000-000000000000"};
test("generated code runs with fixed offline Maven arguments, readonly sources/cache and no host credentials", () => {
  const args = dockerCreateArgs(input, "example.RegressionTest");
  for (const flag of ["--pull=never", "--network=none", "--read-only", "--cap-drop=ALL",
    "--security-opt=no-new-privileges:true", "--log-driver=none", "--offline", "-Dtest=example.RegressionTest"]) assert.ok(args.includes(flag));
  assert.ok(args.includes("type=bind,src=/private/snapshot,dst=/work,readonly"));
  assert.ok(args.includes("type=bind,src=/private/m2/repository,dst=/m2,readonly"));
  assert.ok(args.includes("type=bind,src=/private/build,dst=/work/module/target"));
  assert.ok(!args.some(a => a.includes("docker.sock") || a.includes("settings.xml") || a.includes(".ssh")));
  assert.equal(args.at(-1), "test");
});
test("image, selector, mount and path injection are rejected", () => {
  for (const path of ["../outside", "/absolute", "src/../outside", "src\\.java", ".git/config", "src/\nfile"]) assert.throws(() => safeRelative(path));
  assert.throws(() => dockerCreateArgs({...input, snapshot: "/tmp/a,readonly=false"}));
  assert.throws(() => dockerCreateArgs({...input, image: "maven:latest"}));
  assert.throws(() => dockerCreateArgs({...input, uid: 0}));
  assert.throws(() => dockerCreateArgs(input, "Example -DskipTests=true"));
});
test("fixes cannot change build files, tests, unselected files or make no-op changes", () => {
  const path = "src/main/java/example/App.java", originals = new Map([[path, "old"]]);
  assert.doesNotThrow(() => validateFixChanges([{path, content: "new"}], originals));
  for (const changes of [[], [{path, content: "old"}], [{path, content: ""}],
    [{path: "pom.xml", content: "new"}], [{path: "src/test/java/Test.java", content: "new"}],
    [{path, content: "new"}, {path, content: "again"}]]) assert.throws(() => validateFixChanges(changes, originals));
});
test("artifact patch includes the new test and source change, preserving final-newline semantics", () => {
  const patch = makePatch([{path: "src/test/java/RegressionTest.java", before: "", after: "test\n", added: true},
    {path: "src/main/java/App.java", before: "old", after: "new\n", added: false}]);
  assert.match(patch, /--- \/dev\/null/);
  assert.match(patch, /@@ -0,0 \+1,1 @@/);
  assert.match(patch, /\\ No newline at end of file/);
  assert.match(patch, /-old/); assert.match(patch, /\+new/);
  assert.throws(() => makePatch([{path: "../escape", before: "", after: "x", added: true}]));
});
test("malformed local model proposals never become executable changes", () => {
  assert.equal(parseTestProposal('{"source":"public class Test {}"}'), "public class Test {}");
  assert.throws(() => parseTestProposal('{"source":""}'));
  assert.throws(() => parseTestProposal('{"source":42}'));
  assert.throws(() => parseFixProposal('{"changes":[]}'));
  assert.throws(() => parseFixProposal('{"changes":[{"path":"A.java","content":false}]}'));
  assert.equal(parseFixProposal('{"changes":[{"path":"A.java","content":"new"}]}').length, 1);
});

test("exported patch can be checked and applied by Git in a disposable checkout", async () => {
  const {mkdtemp, mkdir, writeFile, readFile, rm} = await import("node:fs/promises");
  const {join, dirname} = await import("node:path");
  const {tmpdir} = await import("node:os");
  const {execFileSync} = await import("node:child_process");
  const directory = await mkdtemp(join(tmpdir(), "proof-patch-"));
  try {
    execFileSync("git", ["init"], {cwd: directory, stdio: "ignore"});
    const source = "src/main/java/App.java", regression = "src/test/java/RegressionTest.java";
    await mkdir(dirname(join(directory, source)), {recursive: true});
    await writeFile(join(directory, source), "old");
    const patch = makePatch([{path: source, before: "old", after: "new\n", added: false},
      {path: regression, before: "", after: "test\n", added: true}]);
    const artifact = join(directory, "candidate.patch"); await writeFile(artifact, patch);
    execFileSync("git", ["apply", "--check", artifact], {cwd: directory});
    execFileSync("git", ["apply", artifact], {cwd: directory});
    assert.equal(await readFile(join(directory, source), "utf8"), "new\n");
    assert.equal(await readFile(join(directory, regression), "utf8"), "test\n");
  } finally {await rm(directory, {recursive: true, force: true});}
});
