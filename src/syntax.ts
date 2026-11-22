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
export interface SyntaxFile { text: string; functions: SyntaxFunction[] }

const GRAMMAR: [RegExp, Grammar][] = [[/\.(?:[cm]?js|jsx)$/i, "javascript"], [/\.tsx$/i, "tsx"], [/\.[cm]?ts$/i, "typescript"], [/\.php$/i, "php"], [/\.go$/i, "go"], [/\.cs$/i, "c_sharp"], [/\.rb$/i, "ruby"]];
export const grammarFor = (path: string): Grammar | undefined => GRAMMAR.find(([re]) => re.test(path))?.[1];

const CLASS = /^(?:class_declaration|class|abstract_class_declaration|interface_declaration|trait_declaration|struct_declaration|record_declaration|module)$/;
const FUNCTION_VALUE = /^(?:arrow_function|function_expression|function|generator_function)$/;
const field = (node: SyntaxNode | null | undefined, name: string) => node?.childForFieldName(name) ?? null;
const named = (node: SyntaxNode | null) => node?.namedChildren.filter(c => !/comment$/.test(c.type)) ?? [];

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
    const functions: SyntaxFunction[] = [];
    // Iterative walk: deeply nested callbacks would overflow a recursive one.
    const work: {node: SyntaxNode; cls: string}[] = [{node: root, cls: ""}];
    while (work.length) {
      const {node, cls} = work.pop()!;
      if (/comment$/.test(node.type)) {
        for (let i = node.startIndex; i < node.endIndex; i++) if (chars[i] !== "\n" && chars[i] !== "\r") chars[i] = " ";
        continue;
      }
      const d = declaration(node, grammar);
      if (d) {
        const [line, column] = at(d.body.startIndex), [endLine, endColumn] = at(node.endIndex - 1);
        functions.push({name: d.name, cls, startLine: node.startPosition.row + 1, endLine: endLine + 1, body: [line, column, endLine, endColumn], params: paramsOf(d.params, grammar)});
      }
      const own = CLASS.test(node.type) ? field(node, "name")?.text ?? cls : cls;
      for (let i = node.namedChildren.length - 1; i >= 0; i--) work.push({node: node.namedChildren[i], cls: own});
    }
    functions.sort((a, b) => a.startLine - b.startLine);
    return {text: chars.join(""), functions};
  } catch {
    return undefined;
  } finally {
    tree.delete();
  }
}
