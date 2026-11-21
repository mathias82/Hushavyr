import * as assert from "node:assert/strict";
import * as vscode from "vscode";

const EXTENSION_ID = "mathias82.hushavyr";

interface PackageJson {
  contributes: {
    commands: Array<{command: string}>;
    chatParticipants?: Array<{id: string; name: string; commands?: Array<{name: string}>}>;
  };
}

function extension(): vscode.Extension<unknown> {
  const found = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(found, EXTENSION_ID + " is not installed in the test host");
  return found;
}

function workspaceFolder(): vscode.WorkspaceFolder {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, "the fixture workspace is not open");
  return folder;
}

/** Captures non-modal notifications so commands run without UI interaction. */
function captureInformationMessages(): {messages: string[]; restore(): void} {
  const window = vscode.window as {showInformationMessage: (...args: unknown[]) => Thenable<unknown>};
  const original = window.showInformationMessage;
  const messages: string[] = [];
  window.showInformationMessage = (message: unknown) => { messages.push(String(message)); return Promise.resolve(undefined); };
  return {messages, restore: () => { window.showInformationMessage = original; }};
}

async function selectWholeFile(relativePath: string): Promise<vscode.TextEditor> {
  const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(workspaceFolder().uri, relativePath));
  const editor = await vscode.window.showTextDocument(document);
  editor.selection = new vscode.Selection(0, 0, document.lineCount - 1, document.lineAt(document.lineCount - 1).text.length);
  return editor;
}

suite("Hushavyr extension (end to end)", () => {
  suiteSetup(async () => {
    await extension().activate();
  });

  teardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  test("activates without throwing", () => {
    assert.equal(extension().isActive, true);
  });

  test("registers every command declared in package.json", async () => {
    const declared = (extension().packageJSON as PackageJson).contributes.commands.map(c => c.command);
    assert.ok(declared.length > 0);
    const registered = new Set(await vscode.commands.getCommands(true));
    assert.deepEqual(declared.filter(command => !registered.has(command)), []);
  });

  test("contributes the @ai-privacy chat participant", () => {
    const participants = (extension().packageJSON as PackageJson).contributes.chatParticipants ?? [];
    const participant = participants.find(p => p.id === "ai-privacy-router.privacy");
    assert.ok(participant, "chat participant is not contributed");
    assert.equal(participant.name, "ai-privacy");
    assert.ok((participant.commands ?? []).some(c => c.name === "review"));
    assert.equal(typeof vscode.chat?.createChatParticipant, "function");
  });

  test("exposes the documented configuration defaults", () => {
    const config = vscode.workspace.getConfiguration("aiPrivacyRouter");
    const defaults: Record<string, unknown> = {
      mandatoryLocalOnly: false,
      requireReviewer: false,
      routingMode: "local-only",
      cloudEscalation: false,
      ollamaEndpoint: "http://127.0.0.1:11434",
      staticAnalysis: true
    };
    for (const [key, value] of Object.entries(defaults)) {
      assert.deepEqual(config.inspect(key)?.defaultValue, value, key);
      assert.deepEqual(config.get(key), value, key);
    }
  });

  test("privacyPreview reports a local classification without echoing the selection", async () => {
    await selectWholeFile(".env");
    await vscode.commands.executeCommand("aiPrivacyRouter.privacyPreview");
    const preview = vscode.window.activeTextEditor?.document;
    assert.ok(preview);
    assert.equal(preview.languageId, "markdown");
    const text = preview.getText();
    assert.match(text, /Privacy Preview/);
    assert.match(text, /\*\*Route:\*\* \S+/);
    assert.match(text, /\*\*Workspace trusted:\*\* true/);
    assert.doesNotMatch(text, /example-not-real-123/);
  });

  test("classifySelection classifies the selected code offline", async () => {
    await selectWholeFile("app.js");
    const capture = captureInformationMessages();
    try {
      await vscode.commands.executeCommand("aiPrivacyRouter.classifySelection");
    } finally { capture.restore(); }
    assert.equal(capture.messages.length, 1);
    assert.match(capture.messages[0], /^Hushavyr: \S+; .*No content transmitted\.$/);
  });

  test("exportSarif writes Hushavyr markers to hushavyr.sarif", async () => {
    const folder = workspaceFolder();
    const fileUri = vscode.Uri.joinPath(folder.uri, "app.js");
    const target = vscode.Uri.joinPath(folder.uri, "hushavyr.sarif");
    const collection = vscode.languages.createDiagnosticCollection("hushavyr-e2e");
    const diagnostic = new vscode.Diagnostic(new vscode.Range(1, 2, 1, 60),
      "Local rule: sql-string-concatenation\nUser input is concatenated into SQL.", vscode.DiagnosticSeverity.Error);
    diagnostic.source = "Hushavyr";
    collection.set(fileUri, [diagnostic]);
    const capture = captureInformationMessages();
    try {
      await vscode.commands.executeCommand("aiPrivacyRouter.exportSarif");
      const sarif = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(target)).toString("utf8"));
      assert.equal(sarif.version, "2.1.0");
      assert.equal(sarif.runs[0].tool.driver.name, "Hushavyr");
      const [result] = sarif.runs[0].results;
      assert.equal(result.ruleId, "sql-string-concatenation");
      assert.equal(result.level, "error");
      assert.equal(result.locations[0].physicalLocation.artifactLocation.uri, "app.js");
      assert.equal(result.locations[0].physicalLocation.region.startLine, 2);
      assert.ok(capture.messages.some(message => message.includes("hushavyr.sarif")));
    } finally {
      capture.restore();
      collection.dispose();
      await vscode.workspace.fs.delete(target).then(undefined, () => undefined);
    }
  });

  test("exportSarif reports when there is nothing to export", async () => {
    const capture = captureInformationMessages();
    try {
      await vscode.commands.executeCommand("aiPrivacyRouter.clearFindings");
      await vscode.commands.executeCommand("aiPrivacyRouter.exportSarif");
    } finally { capture.restore(); }
    assert.ok(capture.messages.some(message => /No Hushavyr findings to export/.test(message)));
  });
});
