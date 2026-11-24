import * as vscode from "vscode";
import {commitChanges, createPullRequest, planPullRequest, secretsInChanges} from "../git/pullRequest";
import {draftPrText, type PrText} from "../git/prText";
import {configuredClient} from "../model/model";

/** Commit all changes to a new branch, push and open a PR, after showing the files and asking. `say` reports progress (chat or notification).
 * `commitOnly` commits on the current branch and stops there: no push, no pull request. */
export async function openPullRequest(title: string, body: string, say: (text: string) => void, cancelled: () => boolean = () => false, commitOnly = false): Promise<string | undefined> {
  const nothing = commitOnly ? "Nothing was committed." : "Nothing was committed or pushed.";
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder || !vscode.workspace.isTrusted || vscode.env?.remoteName) {
    say("Open a trusted local repository folder first. " + nothing);
    return;
  }
  await vscode.workspace.saveAll(false);
  const plan = await planPullRequest(folder.uri.fsPath, undefined, commitOnly);
  if (typeof plan === "string") { say(plan); return; }
  say("**Changes** (" + plan.files.length + " files, branch `" + plan.current + "`):\n\n```\n" + (plan.stat || plan.files.join("\n")).slice(0, 4000).replace(/```/g, "ˋˋˋ") + "\n```\n");
  const secrets = await secretsInChanges(plan);
  if (secrets.length) {
    say("Stopped: possible credentials in " + secrets.map(f => "`" + f + "`").join(", ") + ". Remove them first. " + nothing);
    return;
  }
  let text: PrText = {commit: "", title: title.trim().split("\n")[0].slice(0, 72), body};
  if (!text.title) {
    say("Writing the commit message" + (commitOnly ? "" : " and pull request text") + " with the local model from the diff…\n\n");
    try { text = await draftPrText(plan, configuredClient(vscode.workspace.getConfiguration("aiPrivacyRouter"))) ?? text; } catch (error) {
      say("The local model could not write the text (" + String((error as Error).message ?? error).split("\n")[0].slice(0, 160).replace(/[`\x5b\x5d]/g, "") + ").\n\n");
    }
    if (cancelled()) { say("Cancelled. " + nothing); return; }
    text.title ||= "Changes prepared with Hushavyr";
  }
  text.commit ||= text.title;
  if (commitOnly) {
    for (;;) {
      say("**Commit:** `" + text.commit.replace(/`/g, "'") + "`\n\n");
      const answer = await vscode.window.showWarningMessage("Commit all " + plan.files.length + " changed files on " + plan.current + "?", {modal: true,
        detail: "Commit: " + text.commit + "\nFiles: " + plan.files.slice(0, 10).join(", ") + (plan.files.length > 10 ? " …" : "") + "\nLocal commit only: nothing is pushed."}, "Commit", "Edit message");
      if (answer === "Edit message") {
        const commit = await vscode.window.showInputBox({title: "Commit message", value: text.commit});
        if (commit?.trim()) text.commit = commit.trim().split("\n")[0].slice(0, 200);
        continue;
      }
      if (answer !== "Commit" || cancelled()) { say("Cancelled. " + nothing); return; }
      break;
    }
    try {
      await commitChanges(plan, text.commit);
      say("Committed on `" + plan.current + "`: `" + text.commit.replace(/`/g, "'") + "`. Not pushed" + (plan.remote ? "; `@ai-privacy /pr` pushes a branch and opens a pull request." : "."));
    } catch (error) {
      say("Git failed: " + String((error as Error).message ?? error).split("\n")[0].slice(0, 300).replace(/[`\[\]]/g, "") + ". Check `git status`.");
    }
    return;
  }
  for (;;) {
    say("**Commit:** `" + text.commit.replace(/`/g, "'") + "`\n\n**Title:** " + text.title.replace(/[*_`]/g, "") + (text.body ? "\n\n" + text.body.replace(/```/g, "ˋˋˋ") : "") + "\n\n");
    const answer = await vscode.window.showWarningMessage("Commit all " + plan.files.length + " changed files, push to origin and open a pull request?", {modal: true,
      detail: "Commit: " + text.commit + "\nTitle: " + text.title + "\nFiles: " + plan.files.slice(0, 10).join(", ") + (plan.files.length > 10 ? " …" : "") +
        "\nThe code goes to your own git remote (" + plan.remote.replace(/\/\/[^@/]+@/, "//") + "), not to an AI service."}, "Create pull request", "Edit text");
    if (answer === "Edit text") {
      const commit = await vscode.window.showInputBox({title: "Commit message", value: text.commit});
      const newTitle = commit === undefined ? undefined : await vscode.window.showInputBox({title: "Pull request title", value: text.title});
      if (commit?.trim()) text.commit = commit.trim().split("\n")[0].slice(0, 200);
      if (newTitle?.trim()) text.title = newTitle.trim().split("\n")[0].slice(0, 72);
      continue;
    }
    if (answer !== "Create pull request" || cancelled()) { say("Cancelled. " + nothing); return; }
    break;
  }
  try {
    const result = await createPullRequest(plan, text.title, undefined, text.body, text.commit);
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
