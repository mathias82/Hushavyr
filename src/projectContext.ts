import {mkdir, readFile, writeFile} from "node:fs/promises";
import {dirname, join} from "node:path";
import {describeHit, Embedder, hitText, indexPath, indexSymbols, ProjectSymbols, rankByName, SearchHit, SearchModel, searchByMeaning, searchWithModel} from "./codeSearch";

/**
 * Context for questions asked inside a project: a project overview for "describe the project", or the code the question is
 * about, found by name, by meaning (local embeddings) or by the local model searching (agentic). Nothing leaves the machine.
 */
export const EMBED_MODEL = "nomic-embed-text";
const MANIFESTS = ["package.json", "pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "go.mod", "pyproject.toml", "requirements.txt", "setup.py",
  "Cargo.toml", "composer.json", "Gemfile", "Dockerfile", "docker-compose.yml"];
const LANGUAGE: Record<string, string> = {java: "Java", kt: "Kotlin", kts: "Kotlin", ts: "TypeScript", tsx: "TypeScript", js: "JavaScript", jsx: "JavaScript", mjs: "JavaScript",
  cjs: "JavaScript", py: "Python", go: "Go", cs: "C#", php: "PHP", rb: "Ruby", rs: "Rust", swift: "Swift", scala: "Scala", groovy: "Groovy", c: "C", cc: "C++", cpp: "C++", h: "C/C++", hpp: "C++"};

/** "describe the project", "what does this app do", "τι κάνει το project", "αρχιτεκτονική"… */
export function isProjectQuestion(text: string): boolean {
  return /\b(?:project|repo(?:sitory)?|code ?base|application|app|architecture|structure|overview|modules?)\b|project|έργο|εφαρμογ|αρχιτεκτονικ|δομή|δομη|πρότζεκτ|προτζεκτ|κώδικα? μας/i.test(text) &&
    /\b(?:describe|explain|summar|overview|what|how|tell|architecture|structure)\w*|περίγραψ|περιγραψ|εξήγ|εξηγ|τι |πώς|πως|πες|συνοψ|αρχιτεκτονικ|δομ/i.test(text);
}

/** Words of a question that look like code identifiers: OrderService, calculate_total, Order.total(), `foo`. */
export function identifierMentions(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/`([^`\n]{2,80})`|\b([A-Za-z_$][\w$]*(?:(?:\.|#|::)[A-Za-z_$][\w$]*)+)\(?\)?|\b([A-Za-z_$][\w$]*)\(\)|\b([a-z]+[A-Z][\w$]*|[A-Z][a-z0-9]+[A-Z][\w$]*|[a-z]+_[a-z_]+)\b/g)) {
    const value = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? "").trim();
    if (value.length >= 3 && !/^(?:e\.g|i\.e)$/i.test(value)) found.add(value);
  }
  return [...found].slice(0, 6);
}

/** A question about some code in the project ("where do we compute the discount?"), worth a search. */
export function looksLikeCodeQuestion(text: string): boolean {
  return text.trim().length >= 12 && /\b(?:where|which|how|what|why|find|show|explain|does|handles?|calls?|uses?|implement\w*|methods?|functions?|class\w*|code|bugs?|logic)\b|πού|που |ποια|ποιο|πώς|πως|τι |γιατί|βρες|δείξε|δειξε|εξήγ|εξηγ|μέθοδ|μεθοδ|κλάσ|κλασ|συνάρτ|συναρτ|κώδικ|κωδικ|λογικ/i.test(text);
}

const read = (path: string, max: number): Promise<string> => readFile(path, "utf8").then(t => t.includes("\0") ? "" : t.slice(0, max)).catch(() => "");

/** A compact description of the project for the local model: README, manifests, folders, languages, main types and entry points. */
export async function projectOverview(project: ProjectSymbols, budget = 14000): Promise<string> {
  const parts: string[] = [];
  const readme = await read(join(project.root, "README.md"), 3500) || await read(join(project.root, "readme.md"), 3500) || await read(join(project.root, "README"), 3500);
  if (readme) parts.push("README (start):\n" + readme);
  for (const name of MANIFESTS) {
    let text = await read(join(project.root, name), 4000);
    if (!text) continue;
    if (name === "package.json") {
      try {
        const p = JSON.parse(text) as Record<string, unknown>;
        text = JSON.stringify({name: p.name, description: p.description, main: p.main, bin: p.bin, scripts: p.scripts,
          dependencies: Object.keys((p.dependencies ?? {}) as object), devDependencies: Object.keys((p.devDependencies ?? {}) as object)}, null, 1);
      } catch { /* keep the raw start */ }
    } else if (name === "pom.xml") {
      text = text.replace(/<!--[\s\S]*?-->/g, "").replace(/\n\s*\n/g, "\n").slice(0, 1800);
    }
    parts.push(name + ":\n" + text.slice(0, 1500));
  }
  const languages = new Map<string, number>(), folders = new Map<string, number>();
  for (const f of project.files) {
    const lang = LANGUAGE[f.split(".").pop()!.toLowerCase()];
    if (lang) languages.set(lang, (languages.get(lang) ?? 0) + 1);
    const dir = f.includes("/") ? f.split("/").slice(0, Math.min(3, f.split("/").length - 1)).join("/") : ".";
    folders.set(dir, (folders.get(dir) ?? 0) + 1);
  }
  parts.push("Source files: " + project.files.length + " (" + [...languages].sort((a, b) => b[1] - a[1]).map(([l, n]) => l + " " + n).join(", ") + ")");
  parts.push("Folders (source files):\n" + [...folders].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([d, n]) => "  " + d + " (" + n + ")").join("\n"));
  const entry = project.symbols.filter(s => /^(?:main|Main|Program|Application|App|Server|index)$/.test(s.name) || /(?:^|\/)(?:main\.go|index\.[jt]s|app\.py|main\.py|manage\.py|server\.[jt]s|Program\.cs)$/.test(s.path) && s.line === 1);
  const entries = [...new Set([...entry.map(s => s.path), ...project.files.filter(f => /(?:^|\/)(?:main\.go|index\.[jt]s|app\.py|main\.py|manage\.py|server\.[jt]s|Program\.cs|\w*Application\.(?:java|kt))$/.test(f))])].slice(0, 12);
  if (entries.length) parts.push("Likely entry points: " + entries.join(", "));
  const byFolder = new Map<string, string[]>();
  for (const s of project.symbols) {
    if (s.kind !== "class" || /(?:^|\/)(?:test|tests|__tests__|spec)\//i.test(s.path) || /Test\b|Tests\b|\.test\.|\.spec\./.test(s.path)) continue;
    const dir = s.path.includes("/") ? s.path.slice(0, s.path.lastIndexOf("/")) : ".";
    const list = byFolder.get(dir) ?? [];
    if (!list.includes(s.name)) list.push(s.name);
    byFolder.set(dir, list);
  }
  const types = [...byFolder].sort((a, b) => b[1].length - a[1].length).map(([d, names]) => "  " + d + ": " + names.slice(0, 25).join(", ") + (names.length > 25 ? " …" : ""));
  if (types.length) parts.push("Main types by folder:\n" + types.join("\n"));
  let text = "";
  for (const part of parts) {
    if (text.length + part.length + 2 > budget) { text += "\n\n" + part.slice(0, Math.max(0, budget - text.length - 20)) + " …"; break; }
    text += (text ? "\n\n" : "") + part;
  }
  return text;
}

export interface FinderOptions {
  root: string;
  /** The chat model, used for agentic search. */
  model?: SearchModel;
  /** Local embedding model; undefined when it is not installed. */
  embedder?: () => Promise<Embedder | undefined>;
  /** Folder that holds the meaning index (outside the repository). */
  indexDir: string;
}

/** Finds code in one project; keeps the symbol table for a minute so a conversation does not re-read every file. */
export class CodeFinder {
  private cached?: {at: number; project: ProjectSymbols};
  constructor(private readonly options: FinderOptions) {}
  get root(): string { return this.options.root; }

  async project(): Promise<ProjectSymbols> {
    if (!this.cached || Date.now() - this.cached.at > 60_000) this.cached = {at: Date.now(), project: await indexSymbols(this.options.root)};
    return this.cached.project;
  }

  /** By name only (fast, no model): best matches, or [] when nothing is close. */
  async byName(query: string, min = 0.82): Promise<SearchHit[]> {
    const project = await this.project();
    return rankByName(project.symbols, query, project.files, min).slice(0, 8);
  }

  /** By meaning with local embeddings; [] when no embedding model is installed. */
  async byMeaning(query: string, signal?: AbortSignal, onProgress?: (message: string) => void, limit = 5): Promise<SearchHit[]> {
    const embedder = await this.options.embedder?.().catch(() => undefined);
    if (!embedder) return [];
    const file = indexPath(this.options.root, this.options.indexDir);
    const store = {load: () => readFile(file, "utf8").catch(() => undefined),
      save: async (text: string) => { await mkdir(dirname(file), {recursive: true}); await writeFile(file, text); }};
    return searchByMeaning(embedder, EMBED_MODEL, await this.project(), query, store, signal, onProgress, limit);
  }

  /**
   * Name first; then meaning and, when a model is given and thorough is set, the model searching with grep.
   * Returns the best hits (at most 5) and how they were found.
   */
  async find(query: string, opts: {signal?: AbortSignal; onProgress?: (message: string) => void; thorough?: boolean} = {}): Promise<SearchHit[]> {
    const named = await this.byName(query, 0.86);
    if (named.length && named[0].score >= 0.9) return named.slice(0, 5);
    const meaning = await this.byMeaning(query, opts.signal, opts.onProgress).catch(() => [] as SearchHit[]);
    if (this.options.model && (opts.thorough || !meaning.length)) {
      opts.onProgress?.("Searching the project with the local model…");
      const picked = await searchWithModel(this.options.model, await this.project(), query, opts.signal, [...named, ...meaning].slice(0, 6)).catch(() => [] as SearchHit[]);
      if (picked.length) return picked;
    }
    return [...named, ...meaning.filter(m => m.score >= 0.5)].slice(0, 5);
  }

  /** Source text of hits with a few lines of context, for a prompt; stays within maxBytes. */
  async sources(hits: readonly SearchHit[], maxBytes = 12000, context = 2): Promise<{path: string; text: string; startLine: number; label: string}[]> {
    const out: {path: string; text: string; startLine: number; label: string}[] = [];
    let bytes = 0;
    for (const hit of hits) {
      const full = await read(join(this.options.root, hit.path), 400_000);
      if (!full) continue;
      const big = hit.kind === "class" && (hit.endLine || 0) - hit.line > 150;
      const part = hitText(full, big ? {line: hit.line, endLine: hit.line + 80} : hit, context);
      if (bytes + part.text.length > maxBytes) continue;
      bytes += part.text.length;
      out.push({path: hit.path, text: part.text, startLine: part.startLine, label: describeHit(hit)});
    }
    return out;
  }
}
