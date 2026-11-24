import * as vscode from "vscode";
import {commitChanges, createPullRequest, planPullRequest, pushBranch, secretsInChanges} from "../git/pullRequest";
import {branchCommits, branchExists, formatBranchCommits, formatBranches, listBranches, planPush, pushCurrent, switchBranch, validBranchName} from "../git/branches";
import {draftPrText, type PrText} from "../git/prText";
import {authorMismatch, keepEmail, mismatchText, useEmail} from "../git/identity";
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
  if (plan.first) say("This repository has no commits yet: `/pr` first pushes an empty \"Initial commit\" to `" + plan.current + "` as the base branch, then opens the pull request from a new branch.\n\n");
  say("**Changes** (" + plan.files.length + " files, branch `" + plan.current + "`):\n\n```\n" + (plan.stat || plan.files.join("\n")).slice(0, 4000).replace(/```/g, "ˋˋˋ") + "\n```\n");
  const secrets = await secretsInChanges(plan);
  if (secrets.length) {
    say("Stopped: possible credentials in " + secrets.map(f => "`" + f + "`").join(", ") + ". Remove them first. " + nothing);
    return;
  }
  if (!await checkAuthor(plan.root)) { say("Cancelled. " + nothing); return; }
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
    const answer = await vscode.window.showWarningMessage("Commit all " + plan.files.length + " changed files, push to origin and open a pull request?", {modal: true,
      detail: "Commit: " + text.commit + "\nTitle: " + text.title + "\nFiles: " + plan.files.slice(0, 10).join(", ") + (plan.files.length > 10 ? " …" : "") +
        "\nThe code goes to your own git remote (" + plan.remote.replace(/\/\/[^@/]+@/, "//") + "), not to an AI service." + (plan.first ? "\nNo commits yet: an empty \"Initial commit\" is pushed to " + plan.current + " first, as the base branch." : "")}, "Create pull request", "Edit text");
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

function gitFolder(say: (text: string) => void): string | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder && vscode.workspace.isTrusted && !vscode.env?.remoteName) return folder.uri.fsPath;
  say("Open a trusted local repository folder first.");
}
const block = (text: string) => "```\n" + text.replace(/```/g, "ˋˋˋ") + "\n```\n";

/** Chat /gitcommits: the commits of the current branch. */
export async function showBranchCommits(say: (text: string) => void): Promise<void> {
  const root = gitFolder(say);
  if (!root) return;
  const c = await branchCommits(root);
  say(typeof c === "string" ? c : block(formatBranchCommits(c)));
}

/** Chat /push: pushes the current branch's commits after asking; uncommitted changes stay local. */
export async function pushBranchFlow(say: (text: string) => void): Promise<void> {
  const root = gitFolder(say);
  if (!root) return;
  const plan = await planPush(root);
  if (typeof plan === "string") { say(plan + " Nothing was pushed."); return; }
  if (plan.dirty) say(plan.dirty + " changed file" + (plan.dirty === 1 ? " is" : "s are") + " not committed and will not be pushed (`@ai-privacy /commit` commits them first).\n\n");
  if (!plan.commits.length && plan.upstream) { say("Nothing to push: `" + plan.branch + "` is up to date with origin."); return; }
  if (!plan.commits.length) say("No new commits: pushing creates `" + plan.branch + "` on origin.\n\n");
  else say("**Commits to push** (" + plan.commits.length + ", branch `" + plan.branch + "`):\n\n" + block(plan.commits.slice(0, 50).join("\n")));
  if (await vscode.window.showWarningMessage("Push " + plan.branch + " to origin?", {modal: true, detail: plan.commits.length + " commit(s). No pull request."}, "Push") !== "Push") {
    say("Cancelled. Nothing was pushed.");
    return;
  }
  try {
    await pushCurrent(root, plan.branch);
    say("Pushed `" + plan.branch + "` to origin.");
  } catch (error) {
    say("The push failed: " + String((error as Error).message ?? error).split("\n").slice(-2).join(" ").slice(0, 300).replace(/[`\[\]]/g, ""));
  }
}

/** Chat /branch: lists branches, or switches (asking before creating one); uncommitted changes come along. */
export async function changeBranch(name: string, say: (text: string) => void): Promise<void> {
  const root = gitFolder(say);
  if (!root) return;
  if (!name) {
    const b = await listBranches(root);
    say(typeof b === "string" ? b : block(formatBranches(b)) + "\n`@ai-privacy /branch <name>` switches; a new name creates the branch.");
    return;
  }
  if (!validBranchName(name)) { say("Invalid branch name `" + name.replace(/`/g, "'") + "`. Use letters, digits, - _ . /"); return; }
  const exists = await branchExists(root, name);
  if (!exists && await vscode.window.showWarningMessage("Branch " + name + " does not exist. Create it from the current branch and switch to it?", {modal: true}, "Create branch") !== "Create branch") {
    say("Cancelled. Still on the same branch.");
    return;
  }
  await vscode.workspace.saveAll(false);
  try {
    const now = await switchBranch(root, name, !exists);
    say((exists ? "Switched to `" : "Created and switched to `") + now + "`. Uncommitted changes came along.");
  } catch (error) {
    say("Git could not switch: " + String((error as Error).message ?? error).split("\n").slice(0, 3).join(" ").slice(0, 400).replace(/[`\[\]]/g, "") + ". Commit (`/commit`) or stash your changes first.");
  }
}

interface GitRepository {rootUri: vscode.Uri; inputBox: {value: string}}
/** The git repository behind a Source Control title click, else the one holding the workspace folder. */
function gitRepository(arg: unknown): GitRepository | undefined {
  const api = vscode.extensions.getExtension<{getAPI(v: 1): {repositories: GitRepository[]}}>("vscode.git")?.exports?.getAPI(1);
  const repos = api?.repositories ?? [];
  const root = (arg as {rootUri?: vscode.Uri} | undefined)?.rootUri?.fsPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return repos.find(r => r.rootUri.fsPath === root) ?? repos.find(r => root?.startsWith(r.rootUri.fsPath)) ?? repos[0];
}

/** Source Control ✨: the local model writes a commit message from the diff into the commit box; the user still commits. */
/** Warns when GitHub would not credit the commit email; "Use …" sets this repository's email. False when the dialog is cancelled. */
export async function checkAuthor(root: string, modal = true): Promise<boolean> {
  const m = await authorMismatch(root);
  if (!m) return true;
  const use = "Use " + m.expected, keep = "Keep " + m.current;
  const answer = modal
    ? await vscode.window.showWarningMessage("Hushavyr: GitHub will not credit these commits to you.", {modal: true, detail: mismatchText(m) + "\n\"" + use + "\" changes only this repository (git config --local user.email)."}, use, keep)
    : await vscode.window.showWarningMessage("Hushavyr: " + mismatchText(m), use, keep);
  if (answer === use) { await useEmail(root, m.expected); void vscode.window.showInformationMessage("Hushavyr: this repository now commits as " + m.expected + "."); return true; }
  if (answer === keep) { await keepEmail(root, m.current); return true; }
  return !modal;
}

export async function writeCommitMessage(arg?: unknown): Promise<void> {
  if (!vscode.workspace.isTrusted || vscode.env?.remoteName) { void vscode.window.showWarningMessage("Hushavyr: open a trusted local repository first."); return; }
  const repo = gitRepository(arg);
  if (!repo) { void vscode.window.showWarningMessage("Hushavyr: no git repository is open."); return; }
  const plan = await planPullRequest(repo.rootUri.fsPath, undefined, true);
  if (typeof plan === "string") { void vscode.window.showInformationMessage("Hushavyr: " + plan); return; }
  await vscode.window.withProgress({location: vscode.ProgressLocation.SourceControl, title: "Hushavyr: writing the commit message locally…", cancellable: true}, async (_progress, token) => {
    const controller = new AbortController();
    token.onCancellationRequested(() => controller.abort());
    try {
      const text = await draftPrText(plan, configuredClient(vscode.workspace.getConfiguration("aiPrivacyRouter")), controller.signal);
      if (controller.signal.aborted) return;
      if (!text?.commit) { void vscode.window.showWarningMessage("Hushavyr: the local model did not return a commit message."); return; }
      repo.inputBox.value = text.commit;
      void checkAuthor(repo.rootUri.fsPath, false);
    } catch (error) {
      if (!controller.signal.aborted) void vscode.window.showWarningMessage("Hushavyr: the local model could not write the message (" + String((error as Error).message ?? error).split("\n")[0].slice(0, 160) + ").");
    }
  });
}

export function registerPullRequestCommand(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.commands.registerCommand("aiPrivacyRouter.generateCommitMessage", (arg?: unknown) => writeCommitMessage(arg)));
  context.subscriptions.push(vscode.commands.registerCommand("aiPrivacyRouter.openPullRequest", async (title?: string, body?: string) => {
    const messages: string[] = [];
    const url = await openPullRequest(typeof title === "string" ? title : "", typeof body === "string" ? body : "", text => messages.push(text));
    const last = (messages.at(-1) ?? "").replace(/[*`]/g, "");
    if (url) void vscode.window.showInformationMessage("Hushavyr: " + last, "Open").then(c => { if (c) void vscode.env.openExternal(vscode.Uri.parse(url)); });
    else if (last) void vscode.window.showInformationMessage("Hushavyr: " + last.slice(0, 400));
  }));
}
