import {createHash} from "node:crypto";
import {readdir, readFile, stat} from "node:fs/promises";
import {join, relative, sep} from "node:path";

/**
 * Finds code in a project by name (typos allowed), by asking the local model which words to grep for (agentic), or by
 * meaning with local embeddings. Everything stays on this machine.
 */
export interface CodeSymbol { path: string; name: string; container: string; kind: "class" | "function"; line: number; endLine: number; signature: string }
export interface SearchHit extends CodeSymbol { score: number; via: "name" | "words" | "meaning" }
export interface SearchModel { generate(prompt: string, options: {schema?: object; signal?: AbortSignal; maxTokens?: number}): Promise<string> }
export interface Embedder { embed(texts: string[], signal?: AbortSignal): Promise<number[][]> }

const SOURCE = /\.(?:java|kt|kts|scala|groovy|[cm]?[jt]sx?|py|go|cs|php|rb|rs|swift|c|cc|cpp|h|hpp)$/i;
const SKIP = new Set([".git", "node_modules", "target", "build", "dist", "out", "coverage", ".venv", "venv", "env", "__pycache__", ".next", ".idea",
  ".vscode", "vendor", "bin", "obj", ".gradle", ".mvn", ".hushavyr", ".tox", ".pytest_cache", "Pods", "DerivedData"]);
export const MAX_SEARCH_FILE_BYTES = 400_000;

/** Source files under root (relative, "/"-separated), skipping build output, dependencies and minified bundles. */
export async function listSourceFiles(root: string, limit = 8000): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    if (found.length >= limit) return;
    const entries = await readdir(dir, {withFileTypes: true}).catch(() => []);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (found.length >= limit) return;
      if (e.isDirectory()) { if (!SKIP.has(e.name) && !e.name.startsWith(".")) await walk(join(dir, e.name)); }
      else if (e.isFile() && SOURCE.test(e.name) && !/\.min\.[cm]?js$|\.d\.ts$/i.test(e.name)) found.push(relative(root, join(dir, e.name)).split(sep).join("/"));
    }
  };
  await walk(root);
  return found;
}

const KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "return", "new", "else", "throw", "function", "do", "try", "synchronized", "using", "lock",
  "foreach", "when", "match", "await", "yield", "typeof", "sizeof", "super", "this", "assert", "print", "elif", "with", "except", "not", "and", "or", "in"]);
const CLASS_DECL = /^\s*(?:(?:export|default|public|private|protected|internal|static|final|abstract|sealed|partial|open|data|inner|readonly|declare)\s+)*(?:class|interface|enum|record|struct|trait|object)\s+([A-Za-z_$][\w$]*)/;
const GO_TYPE = /^type\s+([A-Za-z_]\w*)\s+(?:struct|interface)\b/;
const GO_FUNC = /^func\s+(?:\(\s*\w*\s*\*?\s*([A-Za-z_]\w*)[^)]*\)\s*)?([A-Za-z_]\w*)\s*[[(]/;
const PY_DEF = /^(\s*)(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)/;
const JS_FUNC = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*[(<]/;
const JS_ARROW = /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/;
const KOTLIN_FUN = /^\s*(?:(?:public|private|protected|internal|override|open|suspend|inline|operator|abstract)\s+)*fun\s+(?:<[^>]+>\s*)?(?:[\w.]+\.)?([A-Za-z_]\w*)\s*\(/;
// A method or constructor: optional modifiers/annotations/return type, a name, then "(" (Java, C#, TS/JS class members, PHP, C-like).
const METHOD = /^\s*(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:public|private|protected|internal|static|final|abstract|synchronized|async|virtual|override|sealed|native|default|extern|unsafe|new|readonly|get|set|function)\s+)*(?:[\w$<>\[\],.?:*&\s]+?\s+)?([A-Za-z_$][\w$]*)\s*(?:<[^>()]*>)?\s*\(/;

/** Strips string literals and line comments so braces inside them are not counted. */
const codeOnly = (line: string): string => line.replace(/"(?:\x5c.|[^"\x5c])*"|'(?:\x5c.|[^'\x5c])*'|`(?:\x5c.|[^`\x5c])*`/g, "\"\"").replace(/\/\/.*$|#(?![\w\[{]).*$/, "");

/**
 * 1-based last line of the block that opens at or after line (brace languages), and whether a body block opened at all
 * ("foo(x, {a: 1});" is a call, not a declaration).
 */
function braceBlock(lines: string[], line: number): {end: number; body: boolean} {
  // Braces inside the parameter list (default values, object types) are not the body.
  let depth = 0, parens = 0, opened = false, block = false;
  for (let i = line - 1; i < lines.length && i < line - 1 + 4000; i++) {
    let text = codeOnly(lines[i]);
    if (block) { const end = text.indexOf("*/"); if (end < 0) continue; text = text.slice(end + 2); block = false; }
    text = text.replace(/\/\*[\s\S]*?\*\//g, "");
    const start = text.indexOf("/*");
    if (start >= 0) { text = text.slice(0, start); block = true; }
    for (let k = 0; k < text.length; k++) {
      const ch = text[k];
      if (!opened && (ch === "(" || ch === ")")) { parens += ch === "(" ? 1 : -1; continue; }
      if (!opened && parens > 0) continue;
      if (ch === "{") { depth++; opened = true; } else if (ch === "}") depth--;
      if (opened && depth <= 0) {
        // "): Promise<{a: string}> {": an object type in the signature closed; the body is the next "{".
        if (i - line < 5 && text.slice(k + 1).includes("{") && !/^\s*[;,)]/.test(text.slice(k + 1))) { opened = false; depth = 0; continue; }
        return {end: i + 1, body: true};
      }
    }
    if (!opened && parens <= 0 && /[;,]\s*$/.test(text)) return {end: i + 1, body: false};
    if (!opened && i - line > 6) return {end: line, body: false};
  }
  return opened ? {end: Math.min(lines.length, line + 3999), body: true} : {end: line, body: false};
}
const braceEnd = (lines: string[], line: number): number => braceBlock(lines, line).end;

/** Python: last line indented deeper than the def/class line. */
function indentEnd(lines: string[], line: number, indent: number): number {
  let end = line;
  for (let i = line; i < lines.length; i++) {
    if (!lines[i].trim() || /^\s*#/.test(lines[i])) continue;
    if (lines[i].length - lines[i].trimStart().length <= indent && !/^\s*[)\]}]/.test(lines[i])) break;
    end = i + 1;
  }
  return end;
}

/** Classes, functions and methods declared in a file, with their line ranges and the class they belong to. */
export function extractSymbols(path: string, text: string): CodeSymbol[] {
  const lines = text.split(/\r?\n/);
  const found: CodeSymbol[] = [];
  const python = /\.py$/i.test(path), go = /\.go$/i.test(path), kotlin = /\.kts?$/i.test(path);
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (inBlock) { if (raw.includes("*/")) inBlock = false; continue; }
    if (/^\s*\/\*/.test(raw) && !raw.includes("*/")) { inBlock = true; continue; }
    if (/^\s*(?:\/\/|\*|#(?!\[))/.test(raw) && !python || python && /^\s*#/.test(raw)) continue;
    const add = (name: string, kind: CodeSymbol["kind"], endLine: number, container = ""): void => {
      if (name.length < (kind === "class" ? 1 : 2) || KEYWORDS.has(name)) return;
      found.push({path, name, container, kind, line: i + 1, endLine: Math.max(i + 1, endLine), signature: raw.trim().slice(0, 160)});
    };
    if (python) {
      const m = PY_DEF.exec(raw);
      if (m) add(m[3], m[2] === "class" ? "class" : "function", indentEnd(lines, i + 1, m[1].length));
      continue;
    }
    if (go) {
      let m = GO_TYPE.exec(raw);
      if (m) { add(m[1], "class", braceEnd(lines, i + 1)); continue; }
      m = GO_FUNC.exec(raw);
      if (m) add(m[2], "function", braceEnd(lines, i + 1), m[1] ?? "");
      continue;
    }
    let m = CLASS_DECL.exec(raw);
    if (m) { add(m[1], "class", braceEnd(lines, i + 1)); continue; }
    m = (kotlin ? KOTLIN_FUN.exec(raw) : null) ?? JS_FUNC.exec(raw) ?? JS_ARROW.exec(raw);
    if (m) { add(m[1], "function", braceEnd(lines, i + 1)); continue; }
    m = METHOD.exec(raw);
    if (m && !/^\s*(?:return|new|throw|else|await|yield|case)\b/.test(raw) && !/[=!<>]=|[^=!<>]=[^=>]|\.\s*$/.test(raw.slice(0, raw.indexOf(m[1])))) {
      // A declaration opens a body; a call ("foo(x, {a: 1});") does not.
      const {end, body} = braceBlock(lines, i + 1);
      if (body) add(m[1], "function", end);
    }
  }
  // Methods belong to the innermost class whose lines contain them; Go methods keep their receiver type.
  const classes = found.filter(s => s.kind === "class");
  for (const s of found) {
    if (s.container) continue;
    let owner: CodeSymbol | undefined;
    for (const c of classes) if (c !== s && c.line <= s.line && s.endLine <= c.endLine && (!owner || c.line >= owner.line)) owner = c;
    if (owner) s.container = owner.name;
  }
  return found;
}

const normalize = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");
/** Edit distance where swapping two neighbouring letters ("crat"/"cart"), the commonest typo, costs half an edit. */
function distance(a: string, b: string): number {
  if (a === b) return 0;
  let before: number[] = [], prev = Array.from({length: b.length + 1}, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) row[j] = Math.min(row[j], before[j - 2] + 0.5);
    }
    before = prev;
    prev = row;
  }
  return prev[b.length];
}
/** 0..1: 1 for the same name, high for a typo (servce/service) or a clear prefix (calcTotal/calculateTotal). */
export function similarity(query: string, name: string): number {
  const q = normalize(query), n = normalize(name);
  if (!q || !n) return 0;
  if (q === n) return 1;
  const edit = 1 - distance(q, n) / Math.max(q.length, n.length);
  // Abbreviations: every query letter appears in order in the name and the first letters match.
  let k = 0;
  for (const ch of n) if (ch === q[k]) k++;
  const subsequence = k === q.length && q[0] === n[0] && q.length >= 4 ? 0.75 + 0.2 * q.length / n.length : 0;
  const contains = q.length >= 4 && n.includes(q) ? 0.7 + 0.25 * q.length / n.length : 0;
  return Math.max(edit, subsequence, contains);
}

/** Splits "OrderService.calculateTotal", "OrderService#calc", "order servce calculate total" into container/name guesses. */
function queryParts(query: string): {container: string; name: string}[] {
  const words = query.trim().split(/\s*(?:\.|#|::|->|\s)\s*/).map(w => w.replace(/\(\)?$|^[@`'"]|[`'"]$/g, "")).filter(Boolean);
  const parts = [{container: "", name: words.join("")}];
  for (let i = 1; i < words.length; i++) parts.push({container: words.slice(0, i).join(""), name: words.slice(i).join("")});
  return parts;
}

/** Symbols matching a name, best first. A file name also matches ("order servce" finds OrderService.java). */
export function rankByName(symbols: readonly CodeSymbol[], query: string, files: readonly string[] = [], min = 0.78): SearchHit[] {
  const parts = queryParts(query);
  const hits: SearchHit[] = [];
  for (const s of symbols) {
    let score = 0;
    for (const p of parts) {
      const value = p.container
        ? Math.min(similarity(p.container, s.container || s.path.split("/").pop()!.replace(/\.\w+$/, "")), similarity(p.name, s.name)) + 0.02
        : Math.max(similarity(p.name, s.name), s.container ? similarity(p.name, s.container + s.name) - 0.01 : 0);
      score = Math.max(score, value);
    }
    if (score >= min) hits.push({...s, score: Math.min(1, score), via: "name"});
  }
  for (const path of files) {
    const stem = path.split("/").pop()!.replace(/\.\w+$/, "");
    const score = Math.max(...parts.filter(p => !p.container).map(p => similarity(p.name, stem)), normalize(query) === normalize(path) ? 1 : 0);
    if (score >= min && !hits.some(h => h.path === path && h.kind === "class" && normalize(h.name) === normalize(stem)))
      hits.push({path, name: stem, container: "", kind: "class", line: 1, endLine: 0, signature: path, score: score - 0.03, via: "name"});
  }
  // Classes first on ties: "OrderService" means the class, not its constructor.
  return hits.sort((a, b) => b.score - a.score || (a.kind === "class" ? -1 : 0) - (b.kind === "class" ? -1 : 0) || a.path.localeCompare(b.path) || a.line - b.line);
}

export interface ProjectSymbols { root: string; files: string[]; symbols: CodeSymbol[] }
/** Reads every source file once (up to a size limit) and extracts its symbols. */
export async function indexSymbols(root: string, files?: string[]): Promise<ProjectSymbols> {
  files ??= await listSourceFiles(root);
  const symbols: CodeSymbol[] = [];
  for (const path of files) {
    const info = await stat(join(root, path)).catch(() => undefined);
    if (!info || info.size > MAX_SEARCH_FILE_BYTES) continue;
    const text = await readFile(join(root, path), "utf8").catch(() => "");
    if (text && !text.includes("\0")) symbols.push(...extractSymbols(path, text));
  }
  return {root, files, symbols};
}

/** Lines of a file that contain any of the words (case-insensitive), mapped to the innermost enclosing symbol. */
export async function grepSymbols(project: ProjectSymbols, words: readonly string[], limit = 40): Promise<SearchHit[]> {
  const terms = [...new Set(words.map(w => w.trim().toLowerCase()).filter(w => w.length >= 3 && w.length <= 60))].slice(0, 8);
  if (!terms.length) return [];
  const scores = new Map<CodeSymbol, Set<string>>();
  for (const path of project.files) {
    const text = await readFile(join(project.root, path), "utf8").catch(() => "");
    if (!text || text.length > MAX_SEARCH_FILE_BYTES) continue;
    const lower = text.toLowerCase();
    if (!terms.some(t => lower.includes(t))) continue;
    const own = project.symbols.filter(s => s.path === path);
    lower.split("\n").forEach((line, i) => {
      for (const t of terms) {
        if (!line.includes(t)) continue;
        let inner: CodeSymbol | undefined;
        for (const s of own) if (s.line <= i + 1 && i + 1 <= s.endLine && (!inner || s.line >= inner.line)) inner = s;
        if (!inner) continue;
        if (!scores.has(inner)) scores.set(inner, new Set());
        scores.get(inner)!.add(t);
      }
    });
  }
  return [...scores].map(([s, hit]) => ({...s, score: hit.size / terms.length, via: "words" as const}))
    .sort((a, b) => b.score - a.score || (a.kind === "function" ? -1 : 1) - (b.kind === "function" ? -1 : 1)).slice(0, limit);
}

const termsSchema = {type: "object", additionalProperties: false, required: ["words"], properties: {words: {type: "array", items: {type: "string"}, maxItems: 8}}} as const;
const pickSchema = {type: "object", additionalProperties: false, required: ["pick"], properties: {pick: {type: "array", items: {type: "integer"}, maxItems: 3},
  words: {type: "array", items: {type: "string"}, maxItems: 8}}} as const;
const parseJson = <T>(raw: string): T | undefined => { try { return JSON.parse(raw) as T; } catch { return undefined; } };

/** Agentic search: the local model proposes identifiers to grep for, sees the matching declarations and picks; up to three rounds. */
export async function searchWithModel(model: SearchModel, project: ProjectSymbols, request: string, signal?: AbortSignal, extra: readonly SearchHit[] = [], rounds = 3): Promise<SearchHit[]> {
  const names = [...new Set(project.symbols.filter(s => s.kind === "class").map(s => s.name))].slice(0, 300).join(", ");
  let words = parseJson<{words?: string[]}>(await model.generate(["Find code in a project for this request. Reply JSON {\"words\":[...]}: up to 8 identifiers or word parts",
    "likely to appear in the names or code of the wanted class or method (English, camelCase pieces, synonyms). REQUEST (untrusted): " + JSON.stringify(request),
    "Some classes in the project: " + names].join("\n"), {schema: termsSchema, signal, maxTokens: 200}))?.words ?? [];
  const tried = new Set<string>();
  for (let round = 0; round < rounds && !signal?.aborted; round++) {
    words = words.filter(w => !tried.has(w.toLowerCase()));
    words.forEach(w => tried.add(w.toLowerCase()));
    const byName = words.flatMap(w => rankByName(project.symbols, w, [], 0.85).slice(0, 4));
    const candidates = dedupe([...extra, ...byName, ...await grepSymbols(project, words)]).slice(0, 12);
    if (!candidates.length) {
      if (!words.length) break;
      words = parseJson<{words?: string[]}>(await model.generate("No code matched " + JSON.stringify(words) + ". Suggest different identifiers for: " + JSON.stringify(request) +
        ". Reply JSON {\"words\":[...]}.", {schema: termsSchema, signal, maxTokens: 200}))?.words ?? [];
      continue;
    }
    const list = candidates.map((c, i) => (i + 1) + ". " + c.path + ":" + c.line + " " + (c.container ? c.container + "." : "") + c.name + " — " + c.signature).join("\n");
    const answer = parseJson<{pick?: number[]; words?: string[]}>(await model.generate(["Which of these declarations is the code the request is about? REQUEST (untrusted): " + JSON.stringify(request),
      "CANDIDATES:\n" + list, "Reply JSON {\"pick\":[numbers, best first, at most 3],\"words\":[]}. If none fits, pick [] and give new words to search."].join("\n"),
      {schema: pickSchema, signal, maxTokens: 200}));
    const picked = (answer?.pick ?? []).filter(n => Number.isInteger(n) && n >= 1 && n <= candidates.length).map(n => candidates[n - 1]);
    if (picked.length) return dedupe(picked).map((h, i) => ({...h, score: 0.9 - i * 0.05}));
    words = answer?.words ?? [];
    if (!words.length) break;
  }
  return [];
}

function dedupe(hits: readonly SearchHit[]): SearchHit[] {
  const seen = new Set<string>();
  return hits.filter(h => { const key = h.path + ":" + h.line + ":" + h.name; if (seen.has(key)) return false; seen.add(key); return true; });
}

interface IndexedChunk { name: string; container: string; kind: CodeSymbol["kind"]; line: number; endLine: number; signature: string; vector: number[] }
interface EmbeddingIndex { model: string; files: Record<string, {mtime: number; size: number; chunks: IndexedChunk[]}> }

/** Where the meaning index for a project lives: outside the repository, so it is never committed. */
export const indexPath = (root: string, dir: string): string => join(dir, "index", createHash("sha256").update(root).digest("hex").slice(0, 16) + ".json");

const cosine = (a: number[], b: number[]): number => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length && i < b.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
};

/**
 * Search by meaning with a local embedding model. The index is updated incrementally: only files whose size or modification
 * time changed are embedded again. Returns the best matches.
 */
export async function searchByMeaning(embedder: Embedder, modelName: string, project: ProjectSymbols, query: string, store: {load(): Promise<string | undefined>; save(text: string): Promise<void>},
  signal?: AbortSignal, onProgress?: (message: string) => void, limit = 5, maxChunks = 6000): Promise<SearchHit[]> {
  let index = parseJson<EmbeddingIndex>(await store.load() ?? "");
  if (!index || index.model !== modelName || typeof index.files !== "object") index = {model: modelName, files: {}};
  const wanted = new Set(project.files);
  for (const path of Object.keys(index.files)) if (!wanted.has(path)) delete index.files[path];
  const stale: {path: string; mtime: number; size: number}[] = [];
  for (const path of project.files) {
    const info = await stat(join(project.root, path)).catch(() => undefined);
    if (!info || info.size > MAX_SEARCH_FILE_BYTES) { delete index.files[path]; continue; }
    const old = index.files[path];
    if (!old || old.mtime !== info.mtimeMs || old.size !== info.size) stale.push({path, mtime: info.mtimeMs, size: info.size});
  }
  let total = Object.values(index.files).reduce((n, f) => n + f.chunks.length, 0), done = 0;
  if (stale.length) onProgress?.("Indexing " + stale.length + " file(s) for search by meaning (local, first time takes longer)…");
  for (const file of stale) {
    if (signal?.aborted) break;
    const text = await readFile(join(project.root, file.path), "utf8").catch(() => "");
    const lines = text.split(/\r?\n/);
    const symbols = project.symbols.filter(s => s.path === file.path);
    // Whole-file chunk for files without declarations (scripts, configs in code).
    const units = symbols.length ? symbols : [{path: file.path, name: file.path.split("/").pop()!, container: "", kind: "class" as const, line: 1, endLine: lines.length, signature: file.path}];
    const chunks: IndexedChunk[] = [];
    for (let i = 0; i < units.length && total + chunks.length < maxChunks; i += 16) {
      const batch = units.slice(i, i + 16);
      const texts = batch.map(s => "search_document: " + file.path + " " + (s.container ? s.container + "." : "") + s.name + "\n" +
        lines.slice(s.line - 1, Math.min(s.endLine, s.line + (s.kind === "class" ? 15 : 60))).join("\n").slice(0, 1800));
      const vectors = await embedder.embed(texts, signal);
      batch.forEach((s, j) => { if (vectors[j]?.length) chunks.push({name: s.name, container: s.container, kind: s.kind, line: s.line, endLine: s.endLine, signature: s.signature,
        vector: vectors[j].map(v => Math.round(v * 1e4) / 1e4)}); });
    }
    index.files[file.path] = {mtime: file.mtime, size: file.size, chunks};
    total += chunks.length;
    if (++done % 50 === 0) { onProgress?.("  " + done + "/" + stale.length + " files"); await store.save(JSON.stringify(index)); }
  }
  if (stale.length) await store.save(JSON.stringify(index));
  const [query_] = await embedder.embed(["search_query: " + query], signal);
  if (!query_?.length) return [];
  const hits: SearchHit[] = [];
  for (const [path, f] of Object.entries(index.files))
    // A small class chunk repeats its methods' text; on a near tie the method is the more precise answer.
    for (const c of f.chunks) hits.push({path, name: c.name, container: c.container, kind: c.kind, line: c.line, endLine: c.endLine, signature: c.signature,
      score: cosine(query_, c.vector) - (c.kind === "class" ? 0.02 : 0), via: "meaning"});
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** The project root for a folder: the nearest parent with .git (or the folder itself). */
export async function projectRoot(cwd: string): Promise<string> {
  for (let dir = cwd; ;) {
    if (await stat(join(dir, ".git")).catch(() => undefined)) return dir;
    const parent = join(dir, "..");
    if (parent === dir) return cwd;
    dir = parent;
  }
}

/** Code lines of a hit with a little surrounding context, for prompts. */
export function hitText(text: string, hit: Pick<CodeSymbol, "line" | "endLine">, context = 0): {startLine: number; text: string} {
  const lines = text.split(/\r?\n/);
  const start = Math.max(1, hit.line - context), end = Math.min(lines.length, (hit.endLine || lines.length) + context);
  return {startLine: start, text: lines.slice(start - 1, end).join("\n")};
}

export const describeHit = (h: CodeSymbol): string => (h.container ? h.container + "." : "") + h.name + (h.kind === "function" ? "()" : "") + "  " + h.path + ":" + h.line + (h.endLine > h.line ? "-" + h.endLine : "");

const indentOf = (line: string): string => /^[ \t]*/.exec(line)![0];

/** Restores the indentation a model dropped when it rewrote one method or class taken out of a file. */
export function keepIndent(original: string, changed: string): string {
  const before = original.split("\n"), first = before.find(l => l.trim());
  if (first === undefined) return changed;
  const indentByText = new Map(before.filter(l => l.trim()).map(l => [l.trim(), indentOf(l).length] as const));
  const counts = new Map<number, number>();
  let after = changed.split("\n");
  for (const line of after) {
    const want = indentByText.get(line.trim());
    if (line.trim() && want !== undefined) counts.set(want - indentOf(line).length, (counts.get(want - indentOf(line).length) ?? 0) + 1);
  }
  const shift = [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? 0;
  if (shift > 0) after = after.map(l => l.trim() ? " ".repeat(shift) + l : l);
  const head = after.findIndex(l => l.trim() === first.trim());
  const last = head >= 0 ? head : after.findIndex(l => l.trim());
  for (let i = 0; i <= last; i++) if (after[i].trim() && indentOf(after[i]).length < indentOf(first).length) after[i] = indentOf(first) + after[i].trimStart();
  return after.join("\n");
}
