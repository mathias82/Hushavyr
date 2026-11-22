import * as vscode from "vscode";
import {configuredClient} from "./model/model";
import {writeRetainedAuditEvent} from "./escalation/audit";
import {runRoutedPrompt, RoutedResult, RoutingPolicy, PublicModel} from "./escalation/routing";

export function formatRouted(result: RoutedResult): string {
  return "**Route:** " + result.provider + " · " + result.reason + "\n\n" +
    (result.text ?? "No answer returned. No automatic retry or provider fallback.");
}
export function createAutoPrompt(context: vscode.ExtensionContext) {
  const policy = (): RoutingPolicy => {
    const config = vscode.workspace.getConfiguration("aiPrivacyRouter");
    const documents = vscode.workspace.textDocuments ?? [];
    const hasOtherDocument = documents.some(doc => {
      return doc.uri.scheme !== "output" && !doc.uri.scheme.startsWith("vscode-chat");
    });
    return {
      mode: config.get<string>("routingMode", "local-only") === "hybrid-public-prompts" ? "hybrid-public-prompts" : "local-only",
      trusted: vscode.workspace.isTrusted,
      isolatedPublicWindow: !(vscode.workspace.workspaceFolders?.length) && !hasOtherDocument,
      mandatoryLocalOnly: config.get<boolean>("mandatoryLocalOnly", false) ||
        vscode.workspace.getConfiguration("chat").get<boolean>("disableAIFeatures", false),
      requireReviewer: config.get<boolean>("requireReviewer", false)
    };
  };
  return async (prompt: string, token: vscode.CancellationToken): Promise<RoutedResult> => {
    const controller = new AbortController();
    const subscription = token.onCancellationRequested(() => controller.abort());
    if (token.isCancellationRequested) controller.abort();
    try {
      return await runRoutedPrompt(prompt, {
        policy, cancelled: () => token.isCancellationRequested,
        local: async exactPrompt => {
          const config = vscode.workspace.getConfiguration("aiPrivacyRouter");
          const client = configuredClient(config);
          await client.ensureAvailable(controller.signal);
          return client.generate(exactPrompt, {signal: controller.signal});
        },
        pickCopilot: () => pickCopilotModel(token),
        confirmPublic: (exactPrompt, modelLabel) => confirmPublicPayload(exactPrompt, modelLabel, token),
        audit: event => writeRetainedAuditEvent(context.globalStorageUri.fsPath + "/audit", event)
      });
    } finally {subscription.dispose();}
  };
}

export async function pickCopilotModel(token: vscode.CancellationToken, placeHolder = "Choose the Copilot model for this public prompt only"): Promise<PublicModel | undefined> {
  const models = (await vscode.lm.selectChatModels({vendor: "copilot"})).filter(model => model.vendor === "copilot");
  if (token.isCancellationRequested || !models.length) return;
  const picked = await vscode.window.showQuickPick(models.map(model => ({
    label: model.name, description: model.id, model
  })), {placeHolder});
  if (!picked || token.isCancellationRequested) return;
  const model = picked.model;
  return {
    id: model.id, label: model.name + " (" + model.id + ")",
    send: async exactPrompt => {
      if (token.isCancellationRequested) throw new Error("Cancelled");
      const requestToken = new vscode.CancellationTokenSource();
      const linked = token.onCancellationRequested(() => requestToken.cancel());
      const seconds = vscode.workspace.getConfiguration("aiPrivacyRouter").get<number>("timeoutSeconds", 180);
      const timer = setTimeout(() => requestToken.cancel(), Math.min(600, Math.max(1, seconds)) * 1000);
      try {
        const response = await model.sendRequest(
          [vscode.LanguageModelChatMessage.User(exactPrompt)], {}, requestToken.token
        );
        let text = "";
        for await (const chunk of response.text) {
          if (requestToken.token.isCancellationRequested) throw new Error("Cancelled");
          text += chunk;
          if (text.length > 100000) throw new Error("Response exceeds local limit");
        }
        return text;
      } finally {clearTimeout(timer); linked.dispose(); requestToken.dispose();}
    }
  };
}

export async function confirmPublicPayload(exactPrompt: string, modelLabel: string, token: vscode.CancellationToken): Promise<boolean> {
  if (token.isCancellationRequested) return false;
  // A webview is not a text document: ordinary editor completion/context cannot
  // automatically pick up an as-yet-unapproved prompt from a preview editor.
  const panel = vscode.window.createWebviewPanel("aiPrivacy.publicPrompt", "Public Copilot payload",
    vscode.ViewColumn.Active, {enableScripts: false, enableCommandUris: false, localResourceRoots: []});
  const data = JSON.stringify({
    destination: "GitHub Copilot", model: modelLabel,
    messages: [{role: "user", content: exactPrompt}],
    workspaceContextIncluded: false, historyIncluded: false, toolsIncluded: false
  }, null, 2).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  panel.webview.html = "<!doctype html><html><head><meta charset=\"utf-8\">" +
    "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'\">" +
    "<style>body{font-family:monospace;padding:24px}pre{white-space:pre-wrap;word-break:break-word}</style>" +
    "</head><body><h2>Exact outbound public payload</h2><p>No file, history, or tool context is added. " +
    "Pattern checks cannot certify privacy. Read every part before approving the notification.</p><pre>" +
    data + "</pre></body></html>";
  return new Promise<boolean>(resolve => {
    let finished = false;
    const finish = (approved: boolean): void => {
      if (finished) return;
      finished = true;
      cancellation.dispose(); closed.dispose(); panel.dispose();
      resolve(approved && !token.isCancellationRequested);
    };
    const cancellation = token.onCancellationRequested(() => finish(false));
    const closed = panel.onDidDispose(() => finish(false));
    if (token.isCancellationRequested) {finish(false); return;}
    // Non-modal so the full, scrollable preview remains readable before approval.
    void vscode.window.showWarningMessage(
      "The preview's exact prompt will leave this device for GitHub Copilot / " + modelLabel +
      ". Confirm only if every part is public and authorized. Closing the preview or dismissing this notification denies sending.",
      {modal: false}, "This exact prompt is public — send"
    ).then(answer => finish(answer === "This exact prompt is public — send"), () => finish(false));
  });
}
