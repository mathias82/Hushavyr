import * as vscode from "vscode";
import {mkdtemp, readFile, rm, lstat} from "node:fs/promises";
import {tmpdir} from "node:os";
import {basename, join, resolve} from "node:path";
import {scanSecrets} from "./secretsScan";
import {assertMatchingRemote, scanResult} from "./fixPrPolicy";
import {addedLines, checkReceipt, compareUrl, prBody, statusPaths, type Exec} from "./pullRequest";

import {exec as execute} from "./exec";
const command: Exec = async (bin, args, cwd) => (await execute(bin, args, {cwd, timeout: 120000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
  env: {...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never"}})).stdout.trim();

/** Gitleaks on the files the patch changes only, so old fixtures elsewhere in the repo do not block every PR. */
async function secretScan(cwd: string): Promise<void> {
  try {
    const files = statusPaths(await command("git", ["status", "--porcelain", "--untracked-files=all"], cwd));
    if (!files.length || files.length > 50) throw new Error("unexpected change set");
    for (const file of files) {
      const {stdout} = await execute("gitleaks", ["dir", "--no-banner", "--redact", "--exit-code", "1", "--", file],
        {cwd, timeout: 120000, maxBuffer: 1024 * 1024});
      scanResult(0, stdout);
    }
  } catch {
    throw new Error("Gitleaks scan blocked publication. Install gitleaks, resolve any findings and retry.");
  }
}
async function confirm(message: string, detail: string, action: string): Promise<boolean> {
  return (await vscode.window.showWarningMessage(message, {modal: true, detail}, action)) === action;
}
async function defaultBase(root: string, current: string): Promise<string> {
  try { return (await command("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], root)).replace(/^origin\//, ""); }
  catch { return current; }
}

/** Publishes only a content-addressed, verified local fix in an isolated git worktree. */
export function registerVerifiedFixPr(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.commands.registerCommand("aiPrivacyRouter.createVerifiedFixPr", async (artifacts?: string) => {
    if (!vscode.workspace.isTrusted || vscode.env?.remoteName) {
      void vscode.window.showWarningMessage("Hushavyr: open the repository in a trusted local window."); return;
    }
    const folder = vscode.workspace.workspaceFolders?.length === 1 ? vscode.workspace.workspaceFolders[0] : undefined;
    if (!folder || folder.uri.scheme !== "file") {
      void vscode.window.showWarningMessage("Hushavyr: open exactly one local Git workspace."); return;
    }
    const root = folder.uri.fsPath;
    // Called from the "Create draft PR" button with the proof folder, or from the Command Palette.
    let receiptPath = typeof artifacts === "string" ? join(artifacts, "receipt.json") : undefined;
    if (!receiptPath) {
      const selected = await vscode.window.showOpenDialog({canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
        defaultUri: vscode.Uri.file(join(context.globalStorageUri.fsPath, "verified-fixes")),
        openLabel: "Select a verified fix receipt.json", filters: {"Proof receipt": ["json"]}});
      const uri = selected?.[0];
      if (!uri || uri.scheme !== "file" || basename(uri.fsPath) !== "receipt.json") return;
      receiptPath = uri.fsPath;
    }
    let worktree: string | undefined;
    let pushed: string | undefined;
    try {
      const patchPath = join(resolve(receiptPath, ".."), "verified.patch");
      if (!(await lstat(patchPath)).isFile()) throw new Error("verified.patch is not a regular file");
      const patch = await readFile(patchPath);
      const rawReceipt = await readFile(receiptPath, "utf8");
      const receipt = checkReceipt(rawReceipt, patch);
      if (typeof receipt === "string") throw new Error(receipt);
      if (scanSecrets(addedLines(patch.toString("utf8"))).length) throw new Error("the patch looks like it contains a credential");
      const top = await command("git", ["rev-parse", "--show-toplevel"], root);
      if (resolve(top) !== resolve(root)) throw new Error("the workspace must be the Git repository root");
      if (await command("git", ["status", "--porcelain"], root)) throw new Error("commit or stash your changes first");
      const head = await command("git", ["rev-parse", "HEAD"], root);
      if (head !== receipt.baseCommit) throw new Error("HEAD differs from the verified base commit; verify the fix again");
      const remote = await command("git", ["remote", "get-url", "origin"], root);
      const ghRepo = await command("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], root);
      assertMatchingRemote(remote, ghRepo);
      const current = await command("git", ["branch", "--show-current"], root);
      const base = await defaultBase(root, current);
      if (!base) throw new Error("cannot find the base branch (detached HEAD and no origin/HEAD)");
      const branch = "hushavyr/verified-fix-" + Date.now().toString(36);
      worktree = await mkdtemp(join(tmpdir(), "hushavyr-pr-"));
      // The worktree starts from the exact commit used to verify the fix; the active checkout is never touched.
      await command("git", ["worktree", "add", "--detach", worktree, head], root);
      await command("git", ["-c", "core.safecrlf=false", "apply", "--check", "--", patchPath], worktree);
      await command("git", ["-c", "core.safecrlf=false", "apply", "--", patchPath], worktree);
      await command("git", ["add", "--intent-to-add", "--all"], worktree); // include the new regression test in the diff
      if (!await command("git", ["status", "--porcelain"], worktree)) throw new Error("the verified patch made no changes");
      await secretScan(worktree);
      const diff = await command("git", ["diff", "--no-ext-diff", "--"], worktree);
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({language: "diff", content: diff}), {preview: false});
      const where = remote.replace(/\/\/[^@/]+@/, "//");
      if (!await confirm("Push this verified fix to a new branch and open a draft pull request?",
        "Review the diff that just opened.\nRemote: " + where + " (your git host, not an AI service)\nBase: " + base + "\nNothing is merged automatically.",
        "Push and open draft PR")) return;
      if (await command("git", ["rev-parse", "HEAD"], root) !== head) throw new Error("the checkout changed; nothing was pushed");
      assertMatchingRemote(await command("git", ["remote", "get-url", "origin"], root), ghRepo);
      await secretScan(worktree);
      await command("git", ["switch", "-c", branch], worktree);
      await command("git", ["add", "--all"], worktree);
      await command("git", ["commit", "-m", "fix: locally verified regression repair"], worktree);
      await command("git", ["push", "--set-upstream", "origin", branch], worktree);
      pushed = branch;
      let url: string | undefined;
      try {
        url = /https:\/\/\S+/.exec(await command("gh", ["pr", "create", "--draft", "--base", base, "--head", branch,
          "--title", "fix: locally verified regression repair", "--body", prBody(receipt)], worktree))?.[0];
      } catch {
        url = compareUrl(remote, base, branch);
        void vscode.window.showWarningMessage("Hushavyr: branch " + branch + " pushed. The gh CLI could not open the PR (install it and run gh auth login)." +
          (url ? " Open it on GitHub instead." : ""), ...(url ? ["Open on GitHub"] : [])).then(c => { if (c && url) void vscode.env.openExternal(vscode.Uri.parse(url)); });
        return;
      }
      void vscode.window.showInformationMessage("Hushavyr: draft PR created" + (url ? ": " + url : "."), ...(url ? ["Open PR"] : [])).then(choice => {
        if (choice === "Open PR" && url && /^https:\/\//.test(url)) void vscode.env.openExternal(vscode.Uri.parse(url));
      });
    } catch (error) {
      const reason = (error instanceof Error ? error.message : "unknown error").split("\n")[0].slice(0, 300);
      void vscode.window.showErrorMessage("Hushavyr: draft PR stopped: " + reason + "." + (pushed ? " Branch " + pushed + " was pushed and may need cleanup." : " Nothing was pushed."));
    } finally {
      if (worktree) {
        try { await command("git", ["worktree", "remove", "--force", worktree], root); await rm(worktree, {recursive: true, force: true}); }
        catch { void vscode.window.showWarningMessage("Hushavyr: remove the temporary worktree manually: " + worktree); }
      }
    }
  }));
}
