import {definedNames, definitionSnippet} from "./callContext";

/**
 * Project-wide (interprocedural, cross-file) taint tracking without a model or Semgrep Pro.
 * Each function gets a summary "parameter i reaches sink K"; summaries are propagated through calls to a fixpoint,
 * then request input (req.query, @RequestParam, Flask/FastAPI route params...) is followed into them.
 * Heuristic and line-based: it reports a path to verify, not a proof.
 */
export type SinkKind = "sql" | "command" | "code" | "path" | "ssrf" | "xss";
export interface TaintFile { path: string; text: string }
export interface TaintFlow { kind: SinkKind; source: {path: string; line: number}; sink: {path: string; line: number}; via: string[] }

const SINKS: {kind: SinkKind; call: RegExp; when?: RegExp}[] = [
  {kind: "sql", call: /(?:^|[^\w$])(?:executeQuery|executeUpdate|execute|executemany|query|raw|createQuery|createNativeQuery|prepareStatement|exec_driver_sql)\s*\(/g},
  {kind: "command", call: /(?:\bos\.(?:system|popen)|child_process\.(?:exec|execSync)|getRuntime\(\)\.exec|(?:^|[^\w$.])(?:exec|execSync|system|popen))\s*\(/g},
  {kind: "command", call: /\bsubprocess\.(?:run|call|Popen|check_output|check_call)\s*\(/g, when: /shell\s*=\s*True/},
  {kind: "code", call: /(?:(?:^|[^\w$.])(?:eval|Function)|\bnew\s+Function)\s*\(/g},
  {kind: "path", call: /(?:\b(?:readFile|readFileSync|createReadStream|sendFile|unlink|unlinkSync)|\bFiles\.(?:readAllBytes|readString|newInputStream|lines|delete)|\bnew\s+(?:File|FileInputStream)|(?:^|[^\w$.])open)\s*\(/g},
  {kind: "ssrf", call: /(?:(?:^|[^\w$.])(?:fetch|urlopen)|\baxios(?:\.(?:get|post|put|request))?|\brequests\.(?:get|post|put|request)|\bhttps?\.get|\bgetForObject|\bgetForEntity)\s*\(/g},
  {kind: "xss", call: /(?:\.(?:innerHTML|outerHTML)\s*\+?=|\bdocument\.write\s*\()/g}
];
const SOURCE = /\b(?:req|request)\.(?:query|params|body|headers|cookies|args|form|values|json|GET|POST|FILES|data)\b|\b(?:getParameter|getHeader|getQueryString)\s*\(/;
const SANITIZER = /\b(?:parseInt|parseFloat|Number|Integer\.parseInt|Long\.parseLong|int|float|bool|escape\w*|encodeURIComponent|sanitize\w*|quote|basename|UUID\.fromString|isValid\w*|validate\w*|clean\w*)\s*\(/;
const ANNOTATED = /@(?:RequestParam|PathVariable|RequestBody|RequestHeader|CookieValue|QueryParam|PathParam|FormParam|HeaderParam)\b/;
const ROUTE = /^\s*@\w+(?:\.\w+)*\.(?:route|get|post|put|delete|patch)\s*\(/;
const MAX_FILES = 3000;

/** Code with comments removed and plain string contents blanked; template literals and f-strings keep their interpolations. */
function code(line: string): string {
  return line.replace(/(?<![fF\w])"(?:[^"\x5c]|\x5c.)*"|(?<![fF\w])'(?:[^'\x5c]|\x5c.)*'/g, "\"\"").replace(/\/\/.*$|(?:^|\s)#.*$/, "");
}

/** Top-level comma-separated arguments from the "(" at open until the matching ")" or end of text. */
function splitArgs(text: string, open: number): string[] {
  const args: string[] = [];
  let depth = 0, current = "";
  for (let i = open + 1; i < text.length; i++) {
    const ch = text[i];
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) { if (depth === 0) break; depth--; }
    else if (ch === "," && depth === 0) { args.push(current); current = ""; continue; }
    current += ch;
  }
  if (current.trim() || args.length) args.push(current);
  return args;
}

interface Param { name: string; annotated: boolean }
function params(snippet: string, path: string): Param[] {
  const open = snippet.indexOf("(");
  if (open < 0) return [];
  const go = /\.go$/i.test(path);
  return splitArgs(snippet, open).map(part => {
    const annotated = ANNOTATED.test(part);
    const bare = part.replace(/@\w+(?:\([^)]*\))?/g, "").replace(/=[\s\S]*$/, "").replace(/^\s*(?:\.\.\.|\*\*|\*)/, "").trim();
    if (/^[{[]/.test(bare)) return {name: "", annotated};
    const name = bare.includes(":") ? bare.split(":")[0].trim() : go ? (/^([A-Za-z_]\w*)/.exec(bare)?.[1] ?? "") : (/([A-Za-z_]\w*)\s*$/.exec(bare)?.[1] ?? "");
    return {name, annotated};
  }).filter(p => p.name !== "self" && p.name !== "cls");
}

interface Fn { name: string; path: string; startLine: number; lines: string[]; params: Param[]; route: boolean }
function functions(file: TaintFile): Fn[] {
  const all = file.text.split(/\r?\n/);
  const fns: Fn[] = [];
  for (const name of definedNames(file.text)) {
    const snippet = definitionSnippet(file.text, name, 300);
    if (!snippet) continue;
    const above = all.slice(Math.max(0, snippet.startLine - 4), snippet.startLine - 1);
    fns.push({name, path: file.path, startLine: snippet.startLine, lines: snippet.text.split("\n"), params: params(snippet.text, file.path), route: above.some(l => ROUTE.test(l))});
  }
  return fns;
}

interface Reach { kind: SinkKind; path: string; line: number; via: string[] }
type Summaries = Map<string, Map<number, Reach>>;
interface Hit extends Reach { origin: number }

/** Follows tainted variables through one body; returns every sink reached (directly or through summarised calls). */
function analyse(lines: readonly string[], firstLine: number, path: string, initial: ReadonlyMap<string, number>, summaries: Summaries, skipFirst: boolean): Hit[] {
  const tainted = new Map(initial);
  const hits: Hit[] = [];
  const origin = (expr: string, line: number): number | undefined => {
    if (SANITIZER.test(expr)) return undefined;
    if (SOURCE.test(expr)) return line;
    for (const word of expr.match(/[A-Za-z_$][\w$]*/g) ?? []) if (tainted.has(word)) return tainted.get(word);
    return undefined;
  };
  lines.forEach((raw, index) => {
    const line = firstLine + index, text = code(raw);
    if (!(skipFirst && index === 0)) {
      const destructure = /^\s*(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(.+)$/.exec(text);
      const assign = /^\s*(?:(?:const|let|var|final|val|auto)\s+)?(?:[\w<>[\],.?]+\s+)?([A-Za-z_$][\w$]*)\s*(\+?=)(?!=)\s*(.+)$/.exec(text);
      if (destructure) {
        const from = origin(destructure[2], line);
        if (from !== undefined) for (const name of destructure[1].split(",")) { const n = name.split(":").pop()!.trim(); if (n) tainted.set(n, from); }
      } else if (assign) {
        const from = origin(assign[3], line);
        if (from !== undefined) tainted.set(assign[1], from);
        else if (assign[2] === "=") tainted.delete(assign[1]);
      }
    }
    for (const sink of SINKS) {
      if (sink.when && !sink.when.test(text)) continue;
      for (const m of text.matchAll(sink.call)) {
        const end = m.index! + m[0].length;
        const arg = m[0].endsWith("(") ? splitArgs(text, end - 1)[0] ?? "" : text.slice(end);
        const from = origin(arg, line);
        if (from !== undefined) hits.push({kind: sink.kind, path, line, via: [], origin: from});
      }
    }
    for (const m of text.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) {
      const summary = summaries.get(m[1]);
      if (!summary || (skipFirst && index === 0) || /\b(?:function|def|fun|func)\s+$/.test(text.slice(0, m.index))) continue;
      splitArgs(text, m.index! + m[0].length - 1).forEach((arg, i) => {
        const reach = summary.get(i), from = reach ? origin(arg, line) : undefined;
        if (reach && from !== undefined) hits.push({...reach, via: [m[1], ...reach.via], origin: from});
      });
    }
  });
  return hits;
}

export function taintFlows(files: readonly TaintFile[]): TaintFlow[] {
  const fns = files.slice(0, MAX_FILES).filter(f => f.text.length <= 200_000).flatMap(functions);
  const summaries: Summaries = new Map();
  for (let round = 0; round < 6; round++) {
    let changed = false;
    for (const fn of fns) fn.params.forEach((p, i) => {
      if (!p.name || summaries.get(fn.name)?.has(i)) return;
      const hit = analyse(fn.lines, fn.startLine, fn.path, new Map([[p.name, fn.startLine]]), summaries, true)
        .find(h => !h.via.includes(fn.name));
      if (!hit) return;
      if (!summaries.has(fn.name)) summaries.set(fn.name, new Map());
      summaries.get(fn.name)!.set(i, {kind: hit.kind, path: hit.path, line: hit.line, via: hit.via});
      changed = true;
    });
    if (!changed) break;
  }
  const flows = new Map<string, TaintFlow>();
  const add = (path: string, hits: Hit[]) => {
    for (const h of hits) {
      const key = h.kind + "|" + h.path + ":" + h.line;
      const flow = {kind: h.kind, source: {path, line: h.origin}, sink: {path: h.path, line: h.line}, via: h.via};
      const known = flows.get(key);
      if (!known || flow.via.length > known.via.length) flows.set(key, flow);
    }
  };
  for (const fn of fns) {
    const entry = fn.params.filter(p => p.name && (p.annotated || fn.route));
    if (entry.length) add(fn.path, analyse(fn.lines, fn.startLine, fn.path, new Map(entry.map(p => [p.name, fn.startLine])), summaries, true));
  }
  for (const file of files.slice(0, MAX_FILES)) if (SOURCE.test(file.text) && file.text.length <= 200_000) add(file.path, analyse(file.text.split(/\r?\n/), 1, file.path, new Map(), summaries, false));
  return [...flows.values()].sort((a, b) => a.sink.path.localeCompare(b.sink.path) || a.sink.line - b.sink.line);
}

const LABEL: Record<SinkKind, string> = {sql: "SQL injection", command: "Command injection", code: "Code injection", path: "Path traversal", ssrf: "Server-side request forgery", xss: "Cross-site scripting"};
export function flowTitle(flow: TaintFlow): string {
  return LABEL[flow.kind] + ": request input reaches this sink" + (flow.via.length ? " through " + flow.via.join(" → ") : "");
}
export const flowSeverity = (flow: TaintFlow): "high" | "medium" => ["sql", "command", "code"].includes(flow.kind) ? "high" : "medium";
