import {test} from "node:test";
import {strict as assert} from "node:assert";
import {answerDifficulty, escalationFragment, reviewDifficulty} from "../difficulty";

const finding = {title: "t", severity: "high", evidence: "e", fix: "f", regressionTest: "r", status: "potential" as const};

test("review is unsure when the answer is unusable, the second pass disagrees or fails, evidence is missing, or complex code has no findings", () => {
  assert.deepEqual(reviewDifficulty({findings: [finding], rejected: 0, verifierRejected: 0}, "x = 1").reasons, []);
  assert.deepEqual(reviewDifficulty(undefined, "").reasons, ["the local answer was unusable"]);
  assert.deepEqual(reviewDifficulty({findings: [], rejected: 0, error: "bad json"}, "").reasons, ["the local answer was unusable"]);
  assert.deepEqual(reviewDifficulty({findings: [finding], rejected: 2, verifierRejected: 1, verifierFailed: true}, "").reasons,
    ["the second local pass could not check the findings", "the second local pass rejected 1 finding(s)", "2 finding(s) had no matching evidence in the code"]);
  assert.deepEqual(reviewDifficulty({findings: [], rejected: 0}, "synchronized void run() {}").reasons, ["no findings in concurrent code"]);
  assert.deepEqual(reviewDifficulty({findings: [], rejected: 0}, "if(a){if(b){if(c){if(d){if(e){if(f){g()}}}}}}").reasons, ["no findings in deeply nested code"]);
  assert.deepEqual(reviewDifficulty({findings: [], rejected: 0}, 'print("{{{{{{")').reasons, [], "braces in strings do not count");
  assert.equal(reviewDifficulty({findings: [finding], rejected: 0}, "synchronized void run() {}").hard, false, "findings on complex code are fine");
});

test("answers are unsure on hedging, an empty answer, or a doubting follow-up (English and Greek)", () => {
  assert.equal(answerDifficulty("It parses the input and returns a list.", "what does it do?").hard, false);
  assert.deepEqual(answerDifficulty("I'm not sure what this returns.", "").reasons, ["the local model said it is unsure"]);
  assert.deepEqual(answerDifficulty("Δεν είμαι σίγουρος.", "").reasons, ["the local model said it is unsure"]);
  assert.deepEqual(answerDifficulty("", "").reasons, ["the local model gave no answer"]);
  assert.deepEqual(answerDifficulty("Yes.", "are you sure?").reasons, ["you doubted the previous answer"]);
  assert.deepEqual(answerDifficulty("Ναι.", "είναι λάθος αυτό").reasons, ["you doubted the previous answer"]);
});

test("the escalation fragment is the whole code if small, else a window around the line that fits", () => {
  assert.deepEqual(escalationFragment("a\nb", 10), {code: "a\nb", startLine: 10});
  const big = Array.from({length: 1000}, (_, i) => "line " + (i + 1)).join("\n");
  assert.equal(escalationFragment(big), undefined, "too big and no line");
  const part = escalationFragment(big, 1, 500, 200)!;
  assert.ok(part.code.length <= 200 && part.code.includes("line 500"));
  assert.equal(part.code.split("\n")[0], "line " + part.startLine);
  assert.equal(escalationFragment(big, 1, 5000), undefined, "line outside the code");
});
