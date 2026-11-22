import {strict as assert} from "node:assert";
import {test} from "node:test";
import {parsePytestReport} from "../../fix/fixProof";
import {dockerCreateArgs} from "../../fix/fixSandbox";

const moduleName = "test_hushavyr_" + "a".repeat(32);
const report = (child = "", failures = 0) => '<?xml version="1.0" encoding="utf-8"?>' +
  '<testsuites><testsuite name="pytest" tests="1" errors="0" skipped="0" failures="' + failures + '">' +
  '<testcase classname="tests.' + moduleName + '" name="test_total">' + child + '</testcase></testsuite></testsuites>';

test("pytest reports distinguish assertions from runtime failures", () => {
  assert.deepEqual(parsePytestReport(report('<failure message="assert 10 == 5">output</failure>', 1)),
    [{className: moduleName, name: "test_total", outcome: "failure"}]);
  assert.deepEqual(parsePytestReport(report()), [{className: moduleName, name: "test_total", outcome: "passed"}]);
  assert.throws(() => parsePytestReport(report('<failure message="ValueError: unexpected">output</failure>', 1)), /assertion/);
  assert.throws(() => parsePytestReport(report('<failure message="assert 10 == 5"/>')), /totals/);
});

test("Python proof runs fixed pytest targets in the offline container", () => {
  const mounts = {snapshot: "/tmp/source", target: "/tmp/report", project: "app", image: "sha256:" + "a".repeat(64),
    uid: 1000, gid: 1000, name: "ai-privacy-fix-12345678-1234-1234-1234-123456789abc"};
  const args = dockerCreateArgs(mounts, moduleName);
  assert.ok(args.includes("--network=none"));
  assert.ok(args.includes("--read-only"));
  assert.ok(args.includes("type=bind,src=/tmp/source,dst=/work,readonly"));
  assert.equal(args.at(-1), "tests/" + moduleName + ".py");
  assert.equal(dockerCreateArgs(mounts).at(-1), "tests");
  assert.throws(() => dockerCreateArgs(mounts, ".."), /selector/);
});

test("Python Docker proof exports an applicable patch and preserves the original",
  {skip: process.env.HUSHAVYR_PYTHON_DOCKER_SMOKE !== "1", timeout: 180000}, async () => {
    const {execFileSync} = await import("node:child_process");
    const {mkdtemp, mkdir, readFile, writeFile, rm} = await import("node:fs/promises");
    const {tmpdir} = await import("node:os");
    const {join} = await import("node:path");
    const {runFixProof} = await import("../../fix/fixProof");
    const {FixSandbox} = await import("../../fix/fixSandbox");
    const directory = await mkdtemp(join(tmpdir(), "python-proof-"));
    const project = join(directory, "project");
    const source = join(project, "pricing.py");
    const before = "def total(n):\n    return n or 10\n";
    const git = (args: string[]) => execFileSync("git", args, {cwd: project, stdio: "ignore"});
    let box: Awaited<ReturnType<typeof FixSandbox.create>> | undefined;
    try {
      await mkdir(join(project, "tests"), {recursive: true});
      await writeFile(source, before);
      await writeFile(join(project, "tests", "test_pricing.py"),
        "from pricing import total\ndef test_existing():\n    assert total(3) == 3\n");
      git(["init", "--initial-branch=main"]);
      git(["add", "."]);
      git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "commit", "-m", "Seed fixture"]);
      box = await FixSandbox.create({profile: "python", project, selected: [source], storage: join(directory, "runs"),
        image: "hushavyr-pytest:local", signal: new AbortController().signal});
      const sandbox = box;
      const receipt = await runFixProof(sandbox.context, {
        cancelled: () => false, run: (stage, target) => sandbox.run(stage, target),
        proposeTest: async () => "from pricing import total\ndef test_zero():\n    assert total(0) == 0\n",
        approveTest: async () => true, writeTest: text => sandbox.writeTest(text),
        proposeFix: async () => [{path: "pricing.py", content: "def total(n):\n    return 10 if n is None else n\n"}],
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
  });
