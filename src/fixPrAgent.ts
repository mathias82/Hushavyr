import * as vscode from "vscode";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {mkdtemp, readFile, rm, lstat} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {sha256} from "./fixProof";

const execute = promisify(execFile);
async function command(bin: string, args: string[], cwd: string): Promise<string> {
  const {stdout} = await execute(bin, args, {cwd, timeout: 120000, maxBuffer: 1024 * 1024,
    env: {...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never"}});
  return stdout.trim();
}
async function confirm(message: string, action: string): Promise<boolean> {
  return (await vscode.window.showWarningMessage(message, {modal: true}, action)) === action;
}
/** Publishes only a content-addressed, verified local fix in an isolated git worktree. */
export function registerVerifiedFixPr(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.commands.registerCommand("aiPrivacyRouter.createVerifiedFixPr", async () => {
    if (!vscode.workspace.isTrusted || vscode.workspace.getConfiguration("chat").get<boolean>("disableAIFeatures", false) !== true) {
      void vscode.window.showWarningMessage("Run in a trusted local-only profile. The fix must have been verified locally.");
      return;
    }
    const folder = vscode.workspace.workspaceFolders?.length === 1 ? vscode.workspace.workspaceFolders[0] : undefined;
    if (!folder || folder.uri.scheme !== "file") {
      void vscode.window.showWarningMessage("Open exactly one local Git workspace."); return;
    }
    const root = folder.uri.fsPath;
    const selected = await vscode.window.showOpenDialog({canSelectFiles: true, canSelectFolders: false,
      canSelectMany: false, openLabel: "Select a verified fix receipt.json"});
    const uri = selected?.[0];
    if (!uri || uri.scheme !== "file" || !uri.fsPath.endsWith("receipt.json")) return;
    let worktree: string | undefined;
    try {
      const receiptPath = uri.fsPath;
      const raw = await readFile(receiptPath, "utf8");
      const receipt = JSON.parse(raw) as {status?: string; baseCommit?: string; patchHash?: string; stages?: {stage: string; exitCode: number}[]; cleanupRequiresAttention?: boolean};
      if (receipt.status !== "verified" || !/^[a-f0-9]{40}$/.test(receipt.baseCommit ?? "") ||
        !/^[a-f0-9]{64}$/.test(receipt.patchHash ?? "") || receipt.cleanupRequiresAttention ||
        !["baseline","red","green","suite"].every(s => receipt.stages?.some(x => x.stage === s))) {
        throw new Error("Not a complete verified local proof receipt");
      }
      const patchPath = join(resolve(receiptPath, ".."), "verified.patch");
      if (!(await lstat(patchPath)).isFile()) throw new Error("Patch is not a regular file");
      const patch = await readFile(patchPath);
      if (patch.length > 1024 * 1024 || sha256(patch) !== receipt.patchHash) throw new Error("Patch hash mismatch");
      const top = await command("git", ["rev-parse","--show-toplevel"], root);
      if (resolve(top) !== resolve(root)) throw new Error("Workspace must be the Git repository root");
      if (await command("git", ["status","--porcelain"], root)) throw new Error("Commit or stash existing changes first");
      const head = await command("git", ["rev-parse","HEAD"], root);
      if (head !== receipt.baseCommit) throw new Error("HEAD differs from the verified base commit; rerun local verification");
      await command("git", ["cat-file","-e",receipt.baseCommit+"^{commit}"],root);
      const remote = await command("gh", ["repo","view","--json","nameWithOwner","--jq",".nameWithOwner"], root);
      if (!/^[\w.-]+\/[\w.-]+$/.test(remote)) throw new Error("Cannot verify GitHub repository");
      const branch = "hushavyr/verified-fix-"+Date.now().toString(36);
      const temp = await mkdtemp(join(tmpdir(),"hushavyr-pr-"));
      worktree = temp;
      // Worktree starts from the exact commit that was used to verify the fix.
      await command("git", ["worktree","add","--detach",temp,head], root);
      await command("git", ["-c","core.safecrlf=false","apply","--check","--",patchPath],temp);
      await command("git", ["-c","core.safecrlf=false","apply","--",patchPath],temp);
      await command("git", ["add","--intent-to-add","--all"],temp); // Include new regression test in diff preview
      const changes = await command("git", ["status","--porcelain"],temp);
      if (!changes) throw new Error("Verified patch made no changes");
      const diff = await command("git", ["diff","--stat"],temp);
      const preview = await vscode.window.showInformationMessage("Verified patch ready in isolated worktree. Review the diff before publishing. "+diff,
        {modal: true}, "Review diff");
      if (preview !== "Review diff") return;
      const diffDocument = await vscode.workspace.openTextDocument({language:"diff",
        content:await command("git",["diff","--no-ext-diff","--"],temp)});
      await vscode.window.showTextDocument(diffDocument,{preview:false});
      if (!await confirm("Publish ONLY this locally verified patch to "+remote+" as a NEW GitHub branch and draft PR? No automatic merge.", "Approve push and draft PR")) return;
      if (await command("git",["rev-parse","HEAD"],root) !== head ||
        await command("git",["status","--porcelain"],root)) throw new Error("Checkout changed; refusing to push");
      await command("git",["switch","-c",branch],temp);
      await command("git",["add","--all"],temp);
      await command("git",["commit","-m","fix: verified local regression repair"],temp);
      await command("git",["push","--set-upstream","origin",branch],temp);
      const url = await command("gh",["pr","create","--draft","--base",await command("git",["branch","--show-current"],root),
        "--head",branch,"--title","fix: locally verified regression repair",
        "--body","Generated by Hushavyr from an approved local red/green/suite proof. Base: "+head+
        "\\nThe user reviewed the patch and approved push and PR creation. Re-run CI and review before merge."],temp);
      void vscode.window.showInformationMessage("Draft PR created: "+url,"Open PR").then(choice => {
        if(choice === "Open PR" && /^https:\/\/github\.com\//.test(url)) void vscode.env.openExternal(vscode.Uri.parse(url));
      });
    } catch (error) {
      void vscode.window.showErrorMessage("Hushavyr PR creation stopped: "+(error instanceof Error ? error.message : "unknown error"));
    } finally {
      if (worktree) {
        try {await command("git",["worktree","remove","--force",worktree],root);
          await rm(worktree,{recursive:true,force:true});
        } catch {void vscode.window.showWarningMessage("Isolated worktree cleanup needs manual attention: "+worktree);}
      }
    }
  }));
}
