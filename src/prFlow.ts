import * as vscode from "vscode";
import {createPullRequest, planPullRequest, secretsInChanges} from "./pullRequest";

/** Commit all changes to a new branch, push and open a PR, after showing the files and asking. `say` reports progress (chat or notification). */
export async function openPullRequest(title: string, body: string, say: (text: string) => void, cancelled: () => boolean = () => false): Promise<string | undefined> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder || !vscode.workspace.isTrusted || vscode.env?.remoteName) {
    say("Open a trusted local repository folder first. Nothing was pushed.");
    return;
  }
  await vscode.workspace.saveAll(false);
  const plan = await planPullRequest(folder.uri.fsPath);
  if (typeof plan === "string") { say(plan); return; }
  say("**Changes** (" + plan.files.length + " files, branch `" + plan.current + "`):\n\n```\n" + (plan.stat || plan.files.join("\n")).slice(0, 4000).replace(/```/g, "ˋˋˋ") + "\n```\n");
  const secrets = await secretsInChanges(plan);
  if (secrets.length) {
    say("Stopped: possible credentials in " + secrets.map(f => "`" + f + "`").join(", ") + ". Remove them first. Nothing was committed or pushed.");
    return;
  }
  const safeTitle = title.trim().split("\n")[0].slice(0, 72) || "Changes prepared with Hushavyr";
  const answer = await vscode.window.showWarningMessage("Commit all " + plan.files.length + " changed files, push to origin and open a pull request?", {modal: true,
    detail: "Title: " + safeTitle + "\nFiles: " + plan.files.slice(0, 10).join(", ") + (plan.files.length > 10 ? " …" : "") +
      "\nThe code goes to your own git remote (" + plan.remote.replace(/\/\/[^@/]+@/, "//") + "), not to an AI service."}, "Create pull request");
  if (answer !== "Create pull request" || cancelled()) { say("Cancelled. Nothing was committed or pushed."); return; }
  try {
    const result = await createPullRequest(plan, safeTitle, undefined, body);
    say(result.created && result.url ? "Pull request opened: " + result.url
      : "Pushed branch `" + result.branch + "`." + (result.url ? " Open the pull request: " + result.url : " Open a pull request on your git host.") + (result.created ? "" : " (Install and log in to the `gh` CLI to open it automatically.)"));
    return result.url;
  } catch (error) {
    say("Git failed: " + String((error as Error).message ?? error).split("\n")[0].slice(0, 300).replace(/[`\[\]]/g, "") + ". Check `git status`.");
  }
}

export function registerPullRequestCommand(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.commands.registerCommand("aiPrivacyRouter.openPullRequest", async (title?: string, body?: string) => {
    const messages: string[] = [];
    const url = await openPullRequest(typeof title === "string" ? title : "", typeof body === "string" ? body : "", text => messages.push(text));
    const last = (messages.at(-1) ?? "").replace(/[*`]/g, "");
    if (url) void vscode.window.showInformationMessage("Hushavyr: " + last, "Open").then(c => { if (c) void vscode.env.openExternal(vscode.Uri.parse(url)); });
    else if (last) void vscode.window.showInformationMessage("Hushavyr: " + last.slice(0, 400));
  }));
}
