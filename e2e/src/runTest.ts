import * as path from "node:path";
import { runTests } from "@vscode/test-electron";

async function main(): Promise<void> {
  const root = path.resolve(__dirname, "../..");
  try {
    await runTests({
      version: process.env.VSCODE_TEST_VERSION || "stable",
      extensionDevelopmentPath: root,
      extensionTestsPath: path.resolve(__dirname, "suite/index"),
      launchArgs: [
        path.join(root, "e2e/fixtures/workspace"),
        "--disable-extensions",
        "--disable-workspace-trust",
        "--skip-welcome",
        "--skip-release-notes"
      ]
    });
  } catch (error) {
    console.error("End-to-end tests failed:", error);
    process.exit(1);
  }
}

void main();
