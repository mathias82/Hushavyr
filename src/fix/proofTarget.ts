import {existsSync} from "node:fs";
import {dirname, join, extname} from "node:path";

export type ProofRunner = "Java / Maven" | "Python / pytest" | "JavaScript / Node.js" | "TypeScript / Node.js" | "Go / go test";

const RUNNERS: Record<string, ProofRunner> = {
  ".java": "Java / Maven", ".py": "Python / pytest",
  ".js": "JavaScript / Node.js", ".cjs": "JavaScript / Node.js", ".mjs": "JavaScript / Node.js",
  ".ts": "TypeScript / Node.js", ".cts": "TypeScript / Node.js", ".mts": "TypeScript / Node.js", ".go": "Go / go test"
};
const PROJECT_FILES: Record<ProofRunner, string[]> = {
  "Java / Maven": ["pom.xml"],
  "Python / pytest": ["pyproject.toml", "setup.py", "setup.cfg", "pytest.ini", "tests"],
  "JavaScript / Node.js": ["package.json"],
  "TypeScript / Node.js": ["package.json"],
  "Go / go test": ["go.mod"]
};

/** Which offline test runner can prove a finding in this file, if any. */
export function runnerFor(file: string): ProofRunner | undefined {
  return RUNNERS[extname(file).toLowerCase()];
}

/** Nearest folder above the file that looks like a project for that runner, never above the workspace root. */
export function projectRootFor(file: string, runner: ProofRunner, stopAt: string, exists: (path: string) => boolean = existsSync): string | undefined {
  for (let dir = dirname(file); dir.startsWith(stopAt); dir = dirname(dir)) {
    if (PROJECT_FILES[runner].some(name => exists(join(dir, name)))) return dir;
    if (dir === stopAt || dirname(dir) === dir) break;
  }
  return undefined;
}
