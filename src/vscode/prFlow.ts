import * as vscode from "vscode";
import {createPullRequest, planPullRequest, secretsInChanges} from "../git/pullRequest";
import {draftPrText, type PrText} from "../git/prText";
import {configuredClient} from "../model/model";

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
  let text: PrText = {commit: "", title: title.trim().split("\n")[0].slice(0, 72), body};
  if (!text.title) {
    say("Writing the commit message and pull request text with the local model from the diff…\n\n");
    try { text = await draftPrText(plan, configuredClient(vscode.workspace.getConfiguration("aiPrivacyRouter"))) ?? text; } catch (error) {
      say("The local model could not write the text (" + String((error as Error).message ?? error).split("\n")[0].slice(0, 160).replace(/[`\x5b\x5d]/g, "") + ").\n\n");
    }
    if (cancelled()) { say("Cancelled. Nothing was committed or pushed."); return; }
    text.title ||= "Changes prepared with Hushavyr";
  }
  text.commit ||= text.title;
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
    if (answer !== "Create pull request" || cancelled()) { say("Cancelled. Nothing was committed or pushed."); return; }
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
