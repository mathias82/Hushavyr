import {createHash, randomUUID} from "node:crypto";

export type CaseOutcome = "passed" | "failure" | "error" | "skipped";
export interface TestCase {className: string; name: string; outcome: CaseOutcome}
export interface TestRun {exitCode: number | null; interrupted: boolean; durationMs: number; cases: TestCase[]}
export interface SourceChange {path: string; content: string}
export type ProofStage = "baseline" | "red" | "green" | "suite";
export interface FixProofContext {profile?: "python" | "node" | "typescript"; baseCommit: string; imageId: string; testClass: string; testPath: string; localModel?: string; dependencySnapshotHash?: string; dependencySnapshotBytes?: number}
export interface FixProofDependencies {
  cancelled(): boolean;
  run(stage: ProofStage, target?: string): Promise<TestRun>;
  proposeTest(): Promise<string>;
  approveTest(source: string): Promise<boolean>;
  writeTest(source: string): Promise<void>;
  proposeFix(testSource: string): Promise<SourceChange[]>;
  approveFix(changes: SourceChange[]): Promise<boolean>;
  applyFix(changes: SourceChange[]): Promise<void>;
}
export interface StageSummary {
  stage: ProofStage; exitCode: number | null; interrupted: boolean; durationMs: number;
  passed: number; failures: number; errors: number; skipped: number; caseSetHash: string;
}
export interface FixProofReceipt extends FixProofContext {
  policyVersion: "maven-red-green-v1" | "pytest-red-green-v1" | "node-red-green-v1" | "typescript-red-green-v1";
  runId: string; startedAtUtc: string; finishedAtUtc?: string; totalDurationMs?: number;
  status: "verified" | "not-verified" | "cancelled";
  reason: string; stages: StageSummary[]; testHash?: string;
}
export const sha256 = (text: string | Buffer): string => createHash("sha256").update(text).digest("hex");
const key = (test: TestCase): string => test.className + "\0" + test.name;
function unique(cases: TestCase[]): boolean {return new Set(cases.map(key)).size === cases.length;}
function green(run: TestRun): boolean {
  return run.exitCode === 0 && !run.interrupted && unique(run.cases) &&
    run.cases.some(t => t.outcome === "passed") &&
    run.cases.every(t => t.outcome === "passed" || t.outcome === "skipped");
}
function summary(stage: ProofStage, run: TestRun): StageSummary {
  return {stage, exitCode: run.exitCode, interrupted: run.interrupted, durationMs: run.durationMs,
    passed: run.cases.filter(t => t.outcome === "passed").length,
    failures: run.cases.filter(t => t.outcome === "failure").length,
    errors: run.cases.filter(t => t.outcome === "error").length,
    skipped: run.cases.filter(t => t.outcome === "skipped").length,
    // Parameterized test names can contain personal data; never persist raw names.
    caseSetHash: sha256(run.cases.map(t => key(t) + "\0" + t.outcome).sort().join("\n"))};
}
/** The bug itself is proven once the approved test failed by assertion on the unchanged code, even if no fix was verified. */
export function bugReproduced(receipt: FixProofReceipt): boolean {
  return receipt.reason !== "regression-not-reproduced" &&
    receipt.stages.some(s => s.stage === "red" && s.exitCode === 1 && !s.interrupted && s.failures > 0 && s.errors === 0 && s.skipped === 0);
}
/** Acceptance comes from the executable red/green pair and suite, never model claims. */
export async function runFixProof(context: FixProofContext, deps: FixProofDependencies): Promise<FixProofReceipt> {
  context = Object.freeze({...context});
  const started = Date.now();
  const receipt: FixProofReceipt = {...context, policyVersion: context.profile === "typescript" ? "typescript-red-green-v1" : context.profile === "node" ? "node-red-green-v1" : context.profile === "python" ? "pytest-red-green-v1" : "maven-red-green-v1", runId: randomUUID(), startedAtUtc: new Date(started).toISOString(), status: "not-verified", reason: "incomplete", stages: []};
  const stop = (reason: string): FixProofReceipt => ({...receipt, reason, finishedAtUtc: new Date().toISOString(), totalDurationMs: Date.now() - started,
    status: deps.cancelled() ? "cancelled" : "not-verified"});
  const run = async (stage: ProofStage, target?: string): Promise<TestRun> => {
    const result = await deps.run(stage, target); receipt.stages.push(summary(stage, result)); return result;
  };
  try {
    if (deps.cancelled()) return stop("cancelled");
    const baseline = await run("baseline");
    if (deps.cancelled()) return stop("cancelled");
    if (!green(baseline)) return stop("baseline-not-green-or-no-tests");
    const source = await deps.proposeTest();
    if (deps.cancelled()) return stop("cancelled");
    if (!await deps.approveTest(source)) return stop("regression-test-not-approved");
    if (deps.cancelled()) return stop("cancelled");
    await deps.writeTest(source); receipt.testHash = sha256(source);
    const red = await run("red", context.testClass);
    if (deps.cancelled()) return stop("cancelled");
    if (red.interrupted || red.exitCode !== 1 || !red.cases.length || !unique(red.cases) ||
      red.cases.some(t => t.className !== context.testClass || t.outcome === "error" || t.outcome === "skipped") ||
      !red.cases.some(t => t.outcome === "failure")) return stop("regression-not-reproduced");
    const changes = (await deps.proposeFix(source)).map(change => Object.freeze({...change}));
    Object.freeze(changes);
    if (!changes.length) return stop("empty-fix");
    if (deps.cancelled()) return stop("cancelled");
    if (!await deps.approveFix(changes)) return stop("fix-not-approved");
    if (deps.cancelled()) return stop("cancelled");
    await deps.applyFix(changes);
    const after = await run("green", context.testClass);
    if (deps.cancelled()) return stop("cancelled");
    if (!green(after) || after.cases.some(t => t.className !== context.testClass || t.outcome !== "passed") ||
      [...red.cases.map(key)].sort().join("\n") !== after.cases.map(key).sort().join("\n")) return stop("regression-not-fixed");
    const suite = await run("suite");
    if (deps.cancelled()) return stop("cancelled");
    const passed = new Set(suite.cases.filter(t => t.outcome === "passed").map(key));
    const required = [...baseline.cases.filter(t => t.outcome === "passed"), ...after.cases];
    if (!green(suite) || required.some(t => !passed.has(key(t)))) return stop("suite-regressed-or-tests-disappeared");
    return {...receipt, status: "verified", reason: "red-green-and-suite-passed", finishedAtUtc: new Date().toISOString(), totalDurationMs: Date.now() - started};
  } catch {return stop("execution-or-validation-failed");}
}

function attributes(text: string): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  const regex = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (const match of text.matchAll(regex)) {
    if (Object.hasOwn(result, match[1])) throw new Error("Duplicate XML attribute");
    result[match[1]] = (match[2] ?? match[3]).replace(/&(?:amp|lt|gt|quot|apos);/g, value =>
      ({"&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'"}[value]!));
  }
  return result;
}
/** Restricted Surefire XML reader: no DTD/entities, no external resources, bounded input. */
export function parseSurefire(xml: string): TestCase[] {
  if (Buffer.byteLength(xml, "utf8") > 1048576 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(xml) || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("Unsafe report");
  const clean = xml.replace(/<!--[\s\S]*?-->/g, "");
  const root = clean.match(/<testsuite\b([^>]*)>/);
  if (!root || !/<\/testsuite>\s*$/.test(clean)) throw new Error("Invalid Surefire report");
  const totals = attributes(root[1]), cases: TestCase[] = [];
  for (const match of clean.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const info = attributes(match[1]);
    if (!info.classname || !info.name) throw new Error("Missing test identity");
    const body = (match[2] ?? "").replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "");
    const statuses = ["failure", "error", "skipped"].filter(tag => new RegExp("<" + tag + "\\b").test(body));
    if (statuses.length > 1) throw new Error("Ambiguous testcase");
    cases.push({className: info.classname, name: info.name, outcome: (statuses[0] ?? "passed") as CaseOutcome});
    if (cases.length > 20000) throw new Error("Too many tests");
  }
  const counts: Record<string, number> = {tests: cases.length,
    failures: cases.filter(t => t.outcome === "failure").length,
    errors: cases.filter(t => t.outcome === "error").length,
    skipped: cases.filter(t => t.outcome === "skipped").length};
  for (const [field, count] of Object.entries(counts)) {
    const value = totals[field] ?? (field === "skipped" ? "0" : "");
    if (!/^\d+$/.test(value) || Number(value) !== count) throw new Error("Report totals mismatch");
  }
  if (!unique(cases)) throw new Error("Duplicate testcase");
  return cases;
}

/** Reads pytest's single JUnit suite and refuses non-assertion regression failures. */
export function parsePytestReport(xml: string): TestCase[] {
  const match = xml.match(/^\s*(?:<\?xml[^?]*\?>\s*)?<testsuites>\s*(<testsuite\b[\s\S]*<\/testsuite>)\s*<\/testsuites>\s*$/);
  if (!match || /<testsuite\b/g.test(match[1].replace(/^<testsuite\b/, ""))) throw new Error("Invalid pytest report");
  const cases = parseSurefire(match[1]);
  const failures = [...match[1].matchAll(/<failure\b([^>]*?)>/g)];
  if (failures.length !== cases.filter(test => test.outcome === "failure").length ||
    failures.some(failure => !/^(?:assert |AssertionError\b)/.test(attributes(failure[1]).message ?? ""))) {
    throw new Error("Pytest failure is not an assertion");
  }
  return cases.map(test => ({...test, className: test.className.replace(/^tests\./, "")}));
}

/** Node 24's JUnit reporter writes file-qualified test cases and summary comments. */
export function parseNodeReport(xml: string): TestCase[] {
  if (Buffer.byteLength(xml) > 1048576 || /<!DOCTYPE|<!ENTITY/i.test(xml) ||
    !/^\s*<\?xml[^?]*\?>\s*<testsuites>[\s\S]*<\/testsuites>\s*$/.test(xml)) {
    throw new Error("Invalid Node test report");
  }
  const cases: TestCase[] = [];
  for (const match of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const info = attributes(match[1]);
    if (!info.file || !info.name) throw new Error("Missing Node test identity");
    const body = match[2] ?? "";
    const skipped = /<skipped\b/.test(body);
    const failure = /<failure\b/.test(body);
    const isAssertion = /cause: AssertionError \[ERR_ASSERTION\]:/.test(body);
    const file = info.file.replace(/^\.\//, "");
    const generated = file.match(/(?:^|\/)(hushavyr-[a-f0-9]{32}\.test\.cjs)$/);
    cases.push({className: generated?.[1] ?? file, name: info.name,
      outcome: failure ? isAssertion ? "failure" : "error" : skipped ? "skipped" : "passed"});
  }
  const summary = xml.match(/<!-- tests (\d+) -->/);
  if (!summary || Number(summary[1]) !== cases.length || !unique(cases)) throw new Error("Node test totals mismatch");
  return cases;
}
