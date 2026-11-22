import {strict as assert} from "node:assert";
import {test} from "node:test";
import {parseGoReport} from "../../fix/fixProof";
import {dockerCreateArgs} from "../../fix/fixSandbox";

const name = "TestHushavyr" + "a".repeat(32);
const event = (o: object) => JSON.stringify({Package: "example.test/pricing", ...o});

test("Go evidence keeps the generated test apart and treats panics as errors", () => {
  const report = [
    event({Action: "run", Test: name}), event({Action: "output", Test: name, Output: "    total_test.go:9: got 10, want 0\n"}),
    event({Action: "fail", Test: name}), event({Action: "pass", Test: "TestExisting"}),
    event({Action: "pass", Test: "TestExisting/sub"}), event({Action: "fail"})
  ].join("\n");
  assert.deepEqual(parseGoReport(report, name), [
    {className: name, name, outcome: "failure"},
    {className: "example.test/pricing", name: "TestExisting", outcome: "passed"}]);
  const panic = [event({Action: "output", Test: name, Output: "panic: runtime error: index out of range\n"}), event({Action: "fail", Test: name})].join("\n");
  assert.equal(parseGoReport(panic, name)[0].outcome, "error");
  assert.deepEqual(parseGoReport(event({Action: "output", Output: "# example.test/pricing [build failed]\n"}), name), []);
});

test("Go proof runs go test offline with a read-only module cache", () => {
  const mounts = {profile: "go" as const, snapshot: "/tmp/src", target: "/tmp/report", project: "", modules: "/tmp/gomod",
    image: "sha256:" + "a".repeat(64), uid: 1000, gid: 1000, name: "ai-privacy-fix-12345678-1234-1234-1234-123456789abc"};
  const args = dockerCreateArgs(mounts, name);
  assert.ok(args.includes("--network=none"));
  assert.ok(args.includes("type=bind,src=/tmp/gomod,dst=/gomod,readonly"));
  assert.ok(args.includes("GOPROXY=off"));
  assert.deepEqual(args.slice(-3), ["-run", "^" + name + "$", "./..."]);
  assert.deepEqual(dockerCreateArgs(mounts).slice(-2), ["hushavyr", "./..."]);
  assert.throws(() => dockerCreateArgs(mounts, "TestX; rm -rf /"), /selector/);
});

test("Go proof runs red and green in offline Docker",
  {skip: process.env.HUSHAVYR_GO_DOCKER_SMOKE !== "1", timeout: 300000}, async () => {
    const {execFileSync} = await import("node:child_process");
    const {mkdtemp, mkdir, writeFile, rm} = await import("node:fs/promises");
    const {tmpdir} = await import("node:os");
    const {join} = await import("node:path");
    const {runFixProof} = await import("../../fix/fixProof");
    const {FixSandbox} = await import("../../fix/fixSandbox");
    const directory = await mkdtemp(join(tmpdir(), "hushavyr-go-proof-"));
    const project = join(directory, "project");
    const source = join(project, "pricing", "pricing.go");
    const git = (args: string[]) => execFileSync("git", args, {cwd: project, stdio: "ignore"});
    let box: Awaited<ReturnType<typeof FixSandbox.create>> | undefined;
    try {
      await mkdir(join(project, "pricing"), {recursive: true});
      await writeFile(join(project, "go.mod"), "module example.test/shop\n\ngo 1.22\n");
      await writeFile(source, "package pricing\n\nfunc Total(n int) int {\n\tif n == 0 {\n\t\treturn 10\n\t}\n\treturn n\n}\n");
      await writeFile(join(project, "pricing", "pricing_test.go"),
        "package pricing\n\nimport \"testing\"\n\nfunc TestExisting(t *testing.T) {\n\tif Total(3) != 3 {\n\t\tt.Fatal(\"want 3\")\n\t}\n}\n");
      git(["init", "--initial-branch=main"]);
      git(["add", "."]);
      git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "commit", "-m", "Seed fixture"]);
      box = await FixSandbox.create({profile: "go", project, selected: [source], storage: join(directory, "runs"),
        image: process.env.HUSHAVYR_GO_IMAGE ?? "golang:1.24", signal: new AbortController().signal});
      const sandbox = box;
      const test = "package pricing\n\nimport \"testing\"\n\nfunc " + sandbox.context.testClass +
        "(t *testing.T) {\n\tif got := Total(0); got != 0 {\n\t\tt.Errorf(\"got %d, want 0\", got)\n\t}\n}\n";
      const receipt = await runFixProof(sandbox.context, {
        cancelled: () => false, run: (stage, target) => sandbox.run(stage, target),
        proposeTest: async () => test, approveTest: async () => true, writeTest: s => sandbox.writeTest(s),
        proposeFix: async () => [{path: "pricing/pricing.go", content: "package pricing\n\nfunc Total(n int) int {\n\treturn n\n}\n"}],
        approveFix: async () => true, applyFix: changes => sandbox.applyFix(changes)
      });
      assert.equal(receipt.status, "verified", receipt.reason);
      assert.equal(receipt.policyVersion, "go-red-green-v1");
    } finally {
      await box?.dispose();
      await rm(directory, {recursive: true, force: true});
    }
  });
