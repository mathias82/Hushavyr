import * as vscode from "vscode";
import {randomUUID} from "node:crypto";
import {escalate} from "./escalation";
import {Difficulty} from "../review/difficulty";
import {confirmPublicPayload, pickCopilotModel} from "../vscode/autoPrompt";
import {writeRetainedAuditEvent} from "./audit";
import {loadIgnore} from "../scan/teamMemory";

/** What still keeps /escalate local, apart from the user's own on/off choice when `ignoreSetting` is set. */
export function escalationBlockers(config: vscode.WorkspaceConfiguration, ignoreSetting = false): string[] {
  const reasons: string[] = [];
  if (!ignoreSetting && !config.get<boolean>("cloudEscalation", false)) reasons.push("`aiPrivacyRouter.cloudEscalation` is off");
  if (config.get<boolean>("mandatoryLocalOnly", false)) reasons.push("`aiPrivacyRouter.mandatoryLocalOnly` is on");
  if (vscode.workspace.getConfiguration("chat").get<boolean>("disableAIFeatures", false)) reasons.push("`chat.disableAIFeatures` is on");
  if (!vscode.workspace.isTrusted) reasons.push("the workspace is not trusted");
  if (vscode.env?.remoteName) reasons.push("this is a remote session");
  return reasons;
}

/** Turns cloud escalation on (after a modal confirmation) or off for the open workspace, else for the user. */
export async function setCloudEscalation(on: boolean): Promise<{changed: boolean; where: string}> {
  const config = vscode.workspace.getConfiguration("aiPrivacyRouter");
  const scope = vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  const where = scope === vscode.ConfigurationTarget.Workspace ? "this workspace" : "all windows";
  if (on && await vscode.window.showWarningMessage("Allow /escalate in " + where + "? It can send a selected, pseudonymized fragment to a Copilot model, only after you approve the exact text.",
    {modal: true}, "Allow") !== "Allow") return {changed: false, where};
  await config.update("cloudEscalation", on, scope);
  return {changed: true, where};
}

interface Fragment {uri?: string; path: string; code: string; question: string}
const fragments = new Map<string, Fragment>();
export const ESCALATE_UNSURE = "aiPrivacyRouter.escalateUnsure";

/** After an unsure local answer: a note and an opt-in button. Nothing is sent from here. */
export function offerEscalation(stream: vscode.ChatResponseStream, difficulty: Difficulty, fragment: Fragment | undefined): boolean {
  const config = vscode.workspace.getConfiguration("aiPrivacyRouter");
  if (!difficulty.hard || config.get<string>("suggestEscalation", "when-unsure") === "never") return false;
  // Policy blocks (mandatory local-only, untrusted, remote) are not the user's to override: stay silent.
  if (escalationBlockers(config, true).length) return false;
  stream.markdown("\n\n_The local model may be wrong here: " + difficulty.reasons.join("; ") + "._" +
    (fragment ? "" : " Select one function and use `@ai-privacy /escalate` to ask Copilot."));
  if (!fragment) return true;
  const id = randomUUID();
  fragments.set(id, fragment);
  if (fragments.size > 20) fragments.delete(fragments.keys().next().value as string);
  stream.button({command: ESCALATE_UNSURE, title: "Ask Copilot (pseudonymized, needs approval)", arguments: [id]});
  return true;
}

async function escalateUnsure(id: string, context: vscode.ExtensionContext): Promise<void> {
  const fragment = fragments.get(id);
  if (!fragment) return;
  const config = vscode.workspace.getConfiguration("aiPrivacyRouter");
  if (!config.get<boolean>("cloudEscalation", false) && !(await setCloudEscalation(true)).changed) return;
  const fresh = vscode.workspace.getConfiguration("aiPrivacyRouter");
  const uri = fragment.uri ? vscode.Uri.parse(fragment.uri) : undefined;
  const folder = uri && vscode.workspace.getWorkspaceFolder(uri);
  const ignored = folder ? (await loadIgnore(folder.uri.fsPath))(fragment.path) : false;
  const source = new vscode.CancellationTokenSource();
  try {
    const result = await escalate({path: fragment.path, code: fragment.code, question: fragment.question,
      localOnly: escalationBlockers(fresh).length > 0, ignored}, {
      pickModel: () => pickCopilotModel(source.token, "Choose the Copilot model for this pseudonymized fragment"),
      confirm: (payload, label) => confirmPublicPayload(payload, label, source.token),
      audit: event => writeRetainedAuditEvent(context.globalStorageUri.fsPath + "/audit", event),
      cancelled: () => source.token.isCancellationRequested
    });
    if (result.outcome !== "sent") {
      void vscode.window.showWarningMessage("Hushavyr: nothing was sent (" + (result.reason ?? result.outcome) + ").");
      return;
    }
    const doc = await vscode.workspace.openTextDocument({language: "markdown", content: "# Copilot answer for `" + fragment.path +
      "`\n\n_Pseudonymized fragment, names restored locally. Not verified: check it locally before applying._\n\n" + (result.text ?? "")});
    await vscode.window.showTextDocument(doc, {viewColumn: vscode.ViewColumn.Beside, preview: true});
  } finally { source.dispose(); }
}

export function registerEscalationCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.commands.registerCommand(ESCALATE_UNSURE, (id: string) => escalateUnsure(id, context)));
}
