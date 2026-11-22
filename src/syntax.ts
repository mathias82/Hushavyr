import {Grammar, grammarParser, SyntaxNode} from "./javaAst";

/**
 * Syntax trees for JavaScript/TypeScript, PHP, Go, C# and Ruby (tree-sitter grammars loaded with the Java one): exact function
 * and method declarations with their parameters, and the source with comments blanked out, so commented-out code is neither
 * a source nor a sink and a function's end is where its body really closes. Undefined, leaving the line-based engine, when the
 * grammar is not loaded or the file does not parse cleanly.
 */
export interface SyntaxParam { name: string; text: string }
/** Lines are 1-based; body is the 0-based [line, column] of the body's first character and of the declaration's last one. */
export interface SyntaxFunction { name: string; cls: string; startLine: number; endLine: number; body: [number, number, number, number]; params: SyntaxParam[] }
/** A declared variable, parameter or field and its simple type name, visible on 0-based rows from..to. */
export interface SyntaxType { name: string; type: string; from: number; to: number }
export interface SyntaxFile { text: string; functions: SyntaxFunction[]; types: SyntaxType[] }

const GRAMMAR: [RegExp, Grammar][] = [[/\.(?:[cm]?js|jsx)$/i, "javascript"], [/\.tsx$/i, "tsx"], [/\.[cm]?ts$/i, "typescript"], [/\.php$/i, "php"], [/\.go$/i, "go"], [/\.cs$/i, "c_sharp"], [/\.rb$/i, "ruby"]];
export const grammarFor = (path: string): Grammar | undefined => GRAMMAR.find(([re]) => re.test(path))?.[1];

const CLASS = /^(?:class_declaration|class|abstract_class_declaration|interface_declaration|trait_declaration|struct_declaration|record_declaration|module)$/;
const FUNCTION_VALUE = /^(?:arrow_function|function_expression|function|generator_function)$/;
const field = (node: SyntaxNode | null | undefined, name: string) => node?.childForFieldName(name) ?? null;
const named = (node: SyntaxNode | null) => node?.namedChildren.filter(c => !/comment$/.test(c.type)) ?? [];

/** Simple name of a declared type (: Pool, *sql.DB, Repository<User> → Pool, DB, Repository); undefined when not a plain named type. */
function simpleType(node: SyntaxNode | null): string | undefined {
  const t = node?.text.replace(/^:\s*/, "").replace(/<[\s\S]*>|\[\s*\]|[*&?]|\s*\|[\s\S]*$/g, "").trim().split(".").pop();
  return t && /^[A-Za-z_]\w*$/.test(t) && !/^(?:any|unknown|object|var|interface)$/.test(t) ? t : undefined;
}

/** Name of one parameter node; "" for a destructuring pattern, which binds no single name. */
function paramName(p: SyntaxNode, grammar: Grammar): string {
  switch (p.type) {
    case "identifier": return p.text;
    case "required_parameter": case "optional_parameter": { const n = field(p, "pattern"); return n ? paramName(n, grammar) : ""; }
    case "assignment_pattern": { const n = field(p, "left"); return n ? paramName(n, grammar) : ""; }
    case "rest_pattern": { const n = named(p)[0]; return n ? paramName(n, grammar) : ""; }
    case "simple_parameter": case "variadic_parameter": case "property_promotion_parameter":
    case "parameter": case "variadic_parameter_declaration":
    case "splat_parameter": case "hash_splat_parameter": case "keyword_parameter": case "block_parameter":
      return field(p, "name")?.text ?? "";
    default: return "";
  }
}

function paramsOf(list: SyntaxNode | null, grammar: Grammar): SyntaxParam[] {
  if (!list) return [];
  if (list.type === "identifier") return [{name: list.text, text: list.text}];
  const out: SyntaxParam[] = [];
  for (const p of named(list)) {
    // Go: a, b string declares two parameters of one type.
    if (grammar === "go" && p.type === "parameter_declaration") {
      const names = p.namedChildren.filter(c => c.type === "identifier");
      for (const n of names.length ? names : [p]) out.push({name: names.length ? n.text : "", text: p.text});
    } else if (grammar === "ruby" && p.type === "optional_parameter") out.push({name: field(p, "name")?.text ?? "", text: p.text});
    else if (p.type !== "attribute_list" && p.type !== "this") out.push({name: paramName(p, grammar), text: p.text});
  }
  return out;
}

/** The function a declaration node defines: its name, parameter list and body; undefined for other nodes. */
function declaration(node: SyntaxNode, grammar: Grammar): {name: string; params: SyntaxNode | null; body: SyntaxNode} | undefined {
  let name: SyntaxNode | null = null, fn: SyntaxNode | null = null;
  switch (node.type) {
    case "function_declaration": case "generator_function_declaration": case "method_definition": case "function_definition":
    case "method_declaration": case "constructor_declaration": case "local_function_statement": case "method": case "singleton_method":
      name = field(node, "name"); fn = node; break;
    case "variable_declarator": case "public_field_definition": case "field_definition":
      name = field(node, "name") ?? field(node, "property"); fn = field(node, "value"); break;
    case "pair": name = field(node, "key"); fn = field(node, "value"); break;
    case "assignment_expression": {
      const left = field(node, "left");
      name = left?.type === "member_expression" ? field(left, "property") : left?.type === "identifier" ? left : null;
      fn = field(node, "right");
      break;
    }
    default: return undefined;
  }
  if (!name || !fn || (fn !== node && !FUNCTION_VALUE.test(fn.type))) return undefined;
  const body = field(fn, "body");
  // Expression-bodied arrows and C# => members have no block for the line-based analysis to walk.
  if (!body || (grammar !== "ruby" && !/^(?:statement_block|compound_statement|block)$/.test(body.type))) return undefined;
  const params = field(fn, "parameters") ?? field(fn, "parameter");
  return {name: name.text.replace(/^["'`]|["'`]$/g, ""), params, body};
}

/** Declared type of name on a 0-based row: the innermost declaration whose scope covers it. */
export function typeOf(file: SyntaxFile, name: string, row: number): string | undefined {
  let best: SyntaxType | undefined;
  for (const t of file.types) if (t.name === name && t.from <= row && row <= t.to && (!best || t.to - t.from < best.to - best.from)) best = t;
  return best?.type;
}

export function parseSyntax(path: string, source: string): SyntaxFile | undefined {
  const grammar = grammarFor(path), parser = grammar && grammarParser(grammar);
  if (!grammar || !parser) return undefined;
  let tree;
  try { tree = parser.parse(source); } catch { return undefined; }
  if (!tree) return undefined;
  try {
    const root = tree.rootNode;
    if (root.hasError) return undefined;
    const chars = source.split(""), starts = [0];
    for (let i = 0; i < source.length; i++) if (source[i] === "\n") starts.push(i + 1);
    const at = (index: number): [number, number] => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= index) lo = mid; else hi = mid - 1; } return [lo, index - starts[lo]]; };
    const functions: SyntaxFunction[] = [], types: SyntaxType[] = [];
    const file: [number, number] = [0, root.endPosition.row];
    // Iterative walk: deeply nested callbacks would overflow a recursive one. scope: rows of the enclosing function, class: of the class.
    const work: {node: SyntaxNode; cls: string; scope: [number, number]; klass: [number, number]}[] = [{node: root, cls: "", scope: file, klass: file}];
    const typed = (name: SyntaxNode | null | undefined, type: SyntaxNode | null, rows: [number, number]) => {
      const t = simpleType(type);
      if (name && t) types.push({name: name.text, type: t, from: rows[0], to: rows[1]});
    };
    while (work.length) {
      const {node, cls, scope, klass} = work.pop()!;
      switch (node.type) {
        // TypeScript: constructor parameter properties (private readonly pool: Pool) are fields of the class.
        case "required_parameter": case "optional_parameter":
          typed(field(node, "pattern"), field(node, "type"), node.namedChildren.some(c => c.type === "accessibility_modifier" || c.text === "readonly") ? klass : scope); break;
        case "public_field_definition": case "field_definition": typed(field(node, "name") ?? field(node, "property"), field(node, "type"), klass); break;
        case "variable_declarator": if (grammar !== "c_sharp") typed(field(node, "name"), field(node, "type"), scope); break;
        // Go: a, b *sql.DB; struct fields are reached as h.db, so they are visible in the whole file.
        case "parameter_declaration": case "var_spec": case "field_declaration":
          if (grammar === "go") for (const n of node.namedChildren) if (n.type === "identifier" || n.type === "field_identifier") typed(n, field(node, "type"), node.type === "field_declaration" ? file : scope);
          break;
      }
      if (/comment$/.test(node.type)) {
        for (let i = node.startIndex; i < node.endIndex; i++) if (chars[i] !== "\n" && chars[i] !== "\r") chars[i] = " ";
        continue;
      }
      const d = declaration(node, grammar);
      if (d) {
        const [line, column] = at(d.body.startIndex), [endLine, endColumn] = at(node.endIndex - 1);
        functions.push({name: d.name, cls, startLine: node.startPosition.row + 1, endLine: endLine + 1, body: [line, column, endLine, endColumn], params: paramsOf(d.params, grammar)});
      }
      const isClass = CLASS.test(node.type), own = isClass ? field(node, "name")?.text ?? cls : cls;
      const rows: [number, number] = [node.startPosition.row, node.endPosition.row];
      const inner = d ? rows : scope, innerClass = isClass ? rows : klass;
      for (let i = node.namedChildren.length - 1; i >= 0; i--) work.push({node: node.namedChildren[i], cls: own, scope: inner, klass: innerClass});
    }
    functions.sort((a, b) => a.startLine - b.startLine);
    return {text: chars.join(""), functions, types};
  } catch {
    return undefined;
  } finally {
    tree.delete();
  }
}
