import {strict as assert} from "node:assert";
import {test} from "node:test";
import {parseNodeReport} from "../fixProof";
import {dockerCreateArgs} from "../fixSandbox";

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
