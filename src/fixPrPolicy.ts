import {FixProofReceipt, sha256} from "./fixProof";

export function validateProof(receipt: FixProofReceipt & {patchHash?: string; cleanupRequiresAttention?: boolean}, patch: Buffer): void {
  if (receipt.status !== "verified" || receipt.reason !== "red-green-and-suite-passed" ||
    receipt.cleanupRequiresAttention || !/^[a-f0-9]{40}$/.test(receipt.baseCommit) ||
    !/^[a-f0-9]{64}$/.test(receipt.patchHash ?? "") || sha256(patch) !== receipt.patchHash ||
    !/^[a-f0-9]{64}$/.test(receipt.testHash ?? "") ||
    receipt.stages?.length !== 4 || receipt.stages.map(s => s.stage).join(",") !== "baseline,red,green,suite") {
    throw new Error("Invalid or incomplete verified proof");
  }
  const [baseline, red, green, suite] = receipt.stages;
  if ([baseline, green, suite].some(s => s.interrupted || s.exitCode !== 0 || s.passed < 1 || s.failures !== 0 || s.errors !== 0) ||
    red.interrupted || red.exitCode !== 1 || red.failures < 1 || red.errors !== 0 || red.skipped !== 0) {
    throw new Error("Proof stages do not satisfy red/green/suite requirements");
  }
}

export function githubRemote(remote: string): string {
  const value = remote.trim();
  const match = value.match(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
  if (!match) throw new Error("Origin is not an unambiguous github.com repository URL");
  return match[1].toLowerCase();
}

export function assertMatchingRemote(origin: string, cliRepository: string): void {
  if (githubRemote(origin) !== cliRepository.trim().toLowerCase()) throw new Error("Git origin and gh repository differ");
}

/** Fail closed if a secret scanner is unavailable or returns an error. */
export function scanResult(exitCode: number, stdout: string): void {
  if (exitCode !== 0 || stdout.trim()) throw new Error("Secret scan failed or detected potential credentials");
}
