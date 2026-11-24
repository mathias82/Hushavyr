import * as vscode from "vscode";
import {commitChanges, createPullRequest, planPullRequest, pushBranch, secretsInChanges} from "../git/pullRequest";
import {draftPrText, type PrText} from "../git/prText";
import {configuredClient} from "../model/model";

/** Commit all changes to a new branch, push and open a PR, after showing the files and asking. `say` reports progress (chat or notification).
 * `commitOnly` commits on the current branch with no pull request; the user can also push that branch (`push` offers it first). */
export async function openPullRequest(title: string, body: string, say: (text: string) => void, cancelled: () => boolean = () => false, commitOnly = false, push = false): Promise<string | undefined> {
  const nothing = commitOnly ? "Nothing was committed." : "Nothing was committed or pushed.";
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder || !vscode.workspace.isTrusted || vscode.env?.remoteName) {
    say("Open a trusted local repository folder first. " + nothing);
    return;
  }
  await vscode.workspace.saveAll(false);
  const plan = await planPullRequest(folder.uri.fsPath, undefined, commitOnly);
  if (typeof plan === "string") { say(plan); return; }
  if (plan.first) say("This repository has no commits yet, so there is no base branch for a pull request. `/pr` makes the first commit on `" + plan.current + "` and pushes it; the next `/pr` opens a pull request.\n\n");
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
      const buttons = !plan.remote ? ["Commit"] : push ? ["Commit and push", "Commit"] : ["Commit", "Commit and push"];
      const answer = await vscode.window.showWarningMessage("Commit all " + plan.files.length + " changed files on " + plan.current + "?", {modal: true,
        detail: "Commit: " + text.commit + "\nFiles: " + plan.files.slice(0, 10).join(", ") + (plan.files.length > 10 ? " …" : "") +
          (plan.remote ? "\n\"Commit and push\" also pushes " + plan.current + " to your own git remote (" + plan.remote.replace(/\/\/[^@/]+@/, "//") + "), not to an AI service. No pull request." : "\nNo origin remote: local commit only.")},
        ...buttons, "Edit message");
      if (answer === "Edit message") {
        const commit = await vscode.window.showInputBox({title: "Commit message", value: text.commit});
        if (commit?.trim()) text.commit = commit.trim().split("\n")[0].slice(0, 200);
        continue;
      }
      if ((answer !== "Commit" && answer !== "Commit and push") || cancelled()) { say("Cancelled. " + nothing); return; }
      push = answer === "Commit and push";
      break;
    }
    try {
      await commitChanges(plan, text.commit);
      if (push) await pushBranch(plan).catch((error: Error) => { throw new Error("committed, but the push failed: " + error.message); });
      say("Committed on `" + plan.current + "`: `" + text.commit.replace(/`/g, "'") + "`. " + (push ? "Pushed `" + plan.current + "` to origin." : "Not pushed" + (plan.remote ? "; `@ai-privacy commit and push` pushes it, `@ai-privacy /pr` opens a pull request." : ".")));
    } catch (error) {
      say("Git failed: " + String((error as Error).message ?? error).split("\n")[0].slice(0, 300).replace(/[`\[\]]/g, "") + ". Check `git status`.");
    }
    return;
  }
  for (;;) {
    say("**Commit:** `" + text.commit.replace(/`/g, "'") + "`\n\n**Title:** " + text.title.replace(/[*_`]/g, "") + (text.body ? "\n\n" + text.body.replace(/```/g, "ˋˋˋ") : "") + "\n\n");
    const answer = await vscode.window.showWarningMessage(plan.first ? "First commit: commit all " + plan.files.length + " files on " + plan.current + " and push " + plan.current + " to origin?"
      : "Commit all " + plan.files.length + " changed files, push to origin and open a pull request?", {modal: true,
      detail: "Commit: " + text.commit + "\nTitle: " + text.title + "\nFiles: " + plan.files.slice(0, 10).join(", ") + (plan.files.length > 10 ? " …" : "") +
        "\nThe code goes to your own git remote (" + plan.remote.replace(/\/\/[^@/]+@/, "//") + "), not to an AI service." + (plan.first ? "\nThe repository has no commits yet, so no pull request is opened: this commit becomes the base branch." : "")}, plan.first ? "Commit and push" : "Create pull request", "Edit text");
    if (answer === "Edit text") {
      const commit = await vscode.window.showInputBox({title: "Commit message", value: text.commit});
      const newTitle = commit === undefined ? undefined : await vscode.window.showInputBox({title: "Pull request title", value: text.title});
      if (commit?.trim()) text.commit = commit.trim().split("\n")[0].slice(0, 200);
      if (newTitle?.trim()) text.title = newTitle.trim().split("\n")[0].slice(0, 72);
      continue;
    }
    if ((answer !== "Create pull request" && answer !== "Commit and push") || cancelled()) { say("Cancelled. " + nothing); return; }
    break;
  }
  try {
    const result = await createPullRequest(plan, text.title, undefined, text.body, text.commit);
    if (result.first) { say("Pushed the first commit to `" + result.branch + "`: `" + text.commit.replace(/`/g, "'") + "`. No pull request: this is the base branch. The next `@ai-privacy /pr` opens one."); return; }
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
