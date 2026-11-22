import {strict as assert} from "node:assert";
import {test} from "node:test";
import {parseNodeReport} from "../../fix/fixProof";
import {dockerCreateArgs} from "../../fix/fixSandbox";

const name = "hushavyr-" + "a".repeat(32) + ".test.cjs";
const report = (body: string) => '<?xml version="1.0" encoding="utf-8"?>' +
  '<testsuites><testcase name="expects zero" file="test/' + name + '">' +
  body + '</testcase><!-- tests 1 --></testsuites>';

test("Node evidence distinguishes assertion failures from runtime errors", () => {
  assert.deepEqual(parseNodeReport(report("<failure>cause: AssertionError [ERR_ASSERTION]: expected zero</failure>")),
    [{className: name, name: "expects zero", outcome: "failure"}]);
  assert.equal(parseNodeReport(report("<failure>cause: TypeError: undefined</failure>"))[0].outcome, "error");
  assert.equal(parseNodeReport(report("<skipped />"))[0].outcome, "skipped");
  assert.throws(() => parseNodeReport(report("").replace("tests 1", "tests 2")), /totals/);
});

test("Node proof runs a fixed offline Docker command", () => {
  const mounts = {profile: "node" as const, snapshot: "/tmp/src", target: "/tmp/report", project: "",
    image: "sha256:" + "a".repeat(64), uid: 1000, gid: 1000,
    name: "ai-privacy-fix-12345678-1234-1234-1234-123456789abc"};
  const args = dockerCreateArgs(mounts, name);
  assert.ok(args.includes("--network=none"));
  assert.ok(args.includes("type=bind,src=/tmp/src,dst=/work,readonly"));
  assert.deepEqual(args.slice(-4), ["--test", "--test-reporter=junit", "--test-reporter-destination=/reports/node.xml", "test/" + name]);
  assert.throws(() => dockerCreateArgs(mounts, "--eval"), /selector/);
});

test("JavaScript and TypeScript proofs run red and green in offline Docker",
  {skip: process.env.HUSHAVYR_NODE_DOCKER_SMOKE !== "1", timeout: 180000}, async () => {
    const {execFileSync} = await import("node:child_process");
    const {mkdtemp, mkdir, readFile, writeFile, rm} = await import("node:fs/promises");
    const {tmpdir} = await import("node:os");
    const {join} = await import("node:path");
    const {runFixProof} = await import("../../fix/fixProof");
    const {FixSandbox} = await import("../../fix/fixSandbox");
    for (const profile of ["node", "typescript"] as const) {
      const directory = await mkdtemp(join(tmpdir(), "hushavyr-node-proof-"));
      const project = join(directory, "project");
      const ts = profile === "typescript";
      const path = ts ? "pricing.mts" : "pricing.cjs";
      const source = join(project, path);
      const before = ts ? "export const total = (n: number) => n || 10;\n" : "exports.total = n => n || 10;\n";
      const testSource = (label: string, input: number) =>
        'const {test} = require("node:test");\nconst assert = require("node:assert/strict");\n' +
        'const {total} = require("../' + path + '");\n' +
        'test("' + label + '", () => assert.equal(total(' + input + '), ' + input + '));\n';
      const git = (args: string[]) => execFileSync("git", args, {cwd: project, stdio: "ignore"});
      let box: Awaited<ReturnType<typeof FixSandbox.create>> | undefined;
      try {
        await mkdir(join(project, "test"), {recursive: true});
        await writeFile(source, before);
        await writeFile(join(project, "test", "pricing.test.cjs"), testSource("existing", 3));
        if (ts) await writeFile(join(project, "tsconfig.json"), JSON.stringify({compilerOptions: {module: "NodeNext", strict: true, types: []}, include: ["pricing.mts"]}));
        git(["init", "--initial-branch=main"]);
        git(["add", "."]);
        git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "commit", "-m", "Seed fixture"]);
        box = await FixSandbox.create({profile, project, selected: [source], storage: join(directory, "runs"),
          image: ts ? "hushavyr-typescript:local" : "node:24-slim", signal: new AbortController().signal});
        const sandbox = box;
        const receipt = await runFixProof(sandbox.context, {
          cancelled: () => false, run: (stage, target) => sandbox.run(stage, target),
          proposeTest: async () => testSource("zero", 0), approveTest: async () => true,
          writeTest: text => sandbox.writeTest(text),
          proposeFix: async () => [{path, content: before.replace("||", "??")}],
          approveFix: async () => true, applyFix: changes => sandbox.applyFix(changes)
        });
        assert.equal(receipt.status, "verified", JSON.stringify(receipt));
        const artifacts = await sandbox.save(receipt);
        git(["apply", "--check", join(artifacts, "verified.patch")]);
        assert.equal(await readFile(source, "utf8"), before);
      } finally {
        if (box) await box.dispose();
        await rm(directory, {recursive: true, force: true});
      }
    }
  });
