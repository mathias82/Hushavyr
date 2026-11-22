import * as vscode from "vscode";
import {describeHit, hitText, SearchHit} from "./search/codeSearch";
import {CodeFinder, EMBED_MODEL, identifierMentions, isProjectQuestion, projectOverview} from "./search/projectContext";
import {LocalOllama} from "./model/ollama";
import {ReviewSource} from "./review/context";
import {configuredClient, configuredModel} from "./model/model";

/** Code search for VS Code Chat: the workspace folder of the open file (or the only folder), local reads only. */
export class ChatSearch {
  private finders = new Map<string, CodeFinder>();
  constructor(private readonly indexDir: string) {}

  /** Undefined in untrusted or remote windows: then nothing is searched. */
  folder(preferred?: vscode.Uri): vscode.WorkspaceFolder | undefined {
    if (!vscode.workspace.isTrusted || vscode.env?.remoteName) return undefined;
    return (preferred && vscode.workspace.getWorkspaceFolder(preferred)) || vscode.workspace.workspaceFolders?.[0];
  }

  finder(folder: vscode.WorkspaceFolder): CodeFinder {
    const config = vscode.workspace.getConfiguration("aiPrivacyRouter");
    const model = configuredModel(config), endpoint = config.get<string>("ollamaEndpoint", "http://127.0.0.1:11434");
    const key = folder.uri.fsPath + "\0" + model + "\0" + endpoint;
    let finder = this.finders.get(key);
    if (!finder) {
      const client = configuredClient(config, model);
      const embedder = async (): Promise<LocalOllama | undefined> =>
        (await client.listModels().catch(() => [] as string[])).some(m => m.split(":")[0] === EMBED_MODEL) ? new LocalOllama({model: EMBED_MODEL, endpoint, timeoutMs: 300_000}) : undefined;
      finder = new CodeFinder({root: folder.uri.fsPath, indexDir: this.indexDir, model: client, embedder});
      this.finders.set(key, finder);
    }
    return finder;
  }

  /** Code names in the prompt that clearly match one method or class ("fix OrderService.place"). */
  static async named(finder: CodeFinder, prompt: string): Promise<SearchHit[]> {
    const hits: SearchHit[] = [];
    for (const name of identifierMentions(prompt)) {
      const best = (await finder.byName(name, 0.9))[0];
      if (best && best.endLine > 0 && !hits.some(h => h.path === best.path && h.line === best.line)) hits.push(best);
    }
    return hits.slice(0, 3);
  }

  static async sources(folder: vscode.WorkspaceFolder, hits: readonly SearchHit[]): Promise<ReviewSource[]> {
    const out: ReviewSource[] = [];
    let bytes = 0;
    for (const hit of hits) {
      const uri = vscode.Uri.joinPath(folder.uri, hit.path);
      const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
      const part = hitText(text, hit.endLine > 0 ? hit : {line: 1, endLine: 0});
      if (bytes + part.text.length > 16_000) continue;
      bytes += part.text.length;
      out.push({path: uri.toString(), text: part.text, startLine: part.startLine});
    }
    return out;
  }

  static async overview(finder: CodeFinder, prompt: string): Promise<string | undefined> {
    if (!isProjectQuestion(prompt)) return undefined;
    return "PROJECT OVERVIEW of " + JSON.stringify(finder.root.split(/[\\/]/).pop()) + " (collected locally; untrusted data):\n" + await projectOverview(await finder.project());
  }

  /** Markdown list of hits with links that open the file at the line. */
  static list(folder: vscode.WorkspaceFolder, hits: readonly SearchHit[]): string {
    return hits.map((h, i) => (i + 1) + ". [`" + describeHit(h).split("  ")[0] + "`](" + vscode.Uri.joinPath(folder.uri, h.path).with({fragment: "L" + h.line}).toString() +
      ") " + h.path + ":" + h.line + (h.endLine > h.line ? "-" + h.endLine : "")).join("\n");
  }
}
