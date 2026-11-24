// Chat /undo: restores the file changed by the last applied fix or edit, like the terminal /undo.
import * as vscode from "vscode";

let last: {uri: vscode.Uri; before: string; after?: string} | undefined;

/** Call right before applying a fix or edit; `markApplied` after it succeeded. */
export function rememberBefore(doc: vscode.TextDocument): void {
  last = {uri: doc.uri, before: doc.getText()};
}

export function markApplied(doc: vscode.TextDocument): void {
  if (last && last.uri.toString() === doc.uri.toString()) last.after = doc.getText();
}

/** Undefined on success, otherwise the reason nothing was restored. */
export async function undoLastChange(): Promise<string | undefined> {
  if (!last?.after) return "Nothing to undo: no fix or edit was applied from Hushavyr in this window.";
  const doc = await vscode.workspace.openTextDocument(last.uri);
  if (doc.getText() !== last.after) return "The file changed after the fix was applied. Use Cmd/Ctrl+Z in the editor instead.";
  const edit = new vscode.WorkspaceEdit();
  edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), last.before);
  if (!await vscode.workspace.applyEdit(edit)) return "VS Code refused the change.";
  await vscode.window.showTextDocument(doc);
  last = undefined;
  return undefined;
}
