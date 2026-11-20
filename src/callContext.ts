import {ReviewSource} from "./context";

/** A workspace file that may contain definitions or callers; path is the editor URI so findings stay clickable. */
export interface CodeFile { path: string; text: string }

const KEYWORDS = new Set(("if for while switch catch return new throw typeof await function def class super this " +
  "print len range str int list dict set map filter sorted isinstance println require import export assert " +
  "synchronized sizeof elif lambda yield with try else do case fn func match").split(" "));
const DECLARATION = [
  // Java / Kotlin / C# / Go methods and functions
  /^\s*(?:(?:public|private|protected|static|final|abstract|synchronized|async|override|suspend|internal|open)\s+)*(?:fun\s+|func\s+(?:\([^)]*\)\s*)?)?(?:[\w<>\[\],.?]+\s+)?(\w+)\s*\([^;]*$/,
  // JavaScript / TypeScript
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*(\w+)\s*\(/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|\w+)\s*=>/,
  // Python
  /^\s*(?:async\s+)?def\s+(\w+)\s*\(/
];

/** Names of functions and methods declared in the text. */
export function definedNames(text: string): Set<string> {
  const names = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(?:\/\/|#|\*|return\b|if\b|for\b|while\b|else\b|switch\b|catch\b|throw\b)/.test(line)) continue;
    for (const pattern of DECLARATION) {
      const name = pattern.exec(line)?.[1];
      if (name && !KEYWORDS.has(name)) { names.add(name); break; }
    }
  }
  return names;
}

/** Functions called but not defined in the text, in order of first use. */
export function calledNames(text: string, limit = 30): string[] {
  const own = definedNames(text);
  const seen = new Set<string>();
  const code = text.replace(/\/\/.*$|#.*$/gm, "").replace(/"(?:[^"\x5c]|\x5c.)*"|'(?:[^'\x5c]|\x5c.)*'/g, "\"\"");
  for (const match of code.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)) {
    const name = match[1];
    if (name.length < 3 || KEYWORDS.has(name) || own.has(name) || /^[A-Z][A-Z0-9_]*$/.test(name)) continue;
    seen.add(name);
    if (seen.size >= limit) break;
  }
  return [...seen];
}

/** Lines of the declaration and its body (brace-balanced, or by indentation for Python), at most maxLines. */
export function definitionSnippet(text: string, name: string, maxLines = 40): {startLine: number; text: string} | undefined {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex(line => !/^\s*(?:\/\/|#|\*|return\b)/.test(line) &&
    DECLARATION.some(pattern => pattern.exec(line)?.[1] === name));
  if (start < 0) return undefined;
  let end = start;
  if (/^\s*(?:async\s+)?def\s/.test(lines[start])) {
    const indent = /^\s*/.exec(lines[start])![0].length;
    while (end + 1 < lines.length && end - start < maxLines - 1 &&
      (!lines[end + 1].trim() || /^\s*/.exec(lines[end + 1])![0].length > indent)) end++;
  } else {
    let depth = 0, opened = false;
    for (let i = start; i < lines.length && i - start < maxLines; i++) {
      for (const ch of lines[i]) { if (ch === "{") { depth++; opened = true; } else if (ch === "}") depth--; }
      end = i;
      if (opened && depth <= 0) break;
      if (!opened && /;\s*$/.test(lines[i])) break;
    }
  }
  return {startLine: start + 1, text: lines.slice(start, end + 1).join("\n")};
}

/** A few lines around the first call of name, skipping its own declaration. */
export function callerSnippet(text: string, name: string, radius = 6): {startLine: number; text: string} | undefined {
  const lines = text.split(/\r?\n/);
  const call = new RegExp("(?:^|[^\\w$])" + name + "\\s*\\(");
  const index = lines.findIndex(line => call.test(line) && !DECLARATION.some(pattern => pattern.exec(line)?.[1] === name));
  if (index < 0) return undefined;
  const start = Math.max(0, index - radius), end = Math.min(lines.length - 1, index + radius);
  return {startLine: start + 1, text: lines.slice(start, end + 1).join("\n")};
}

/**
 * Cross-file data-flow context for one reviewed file: definitions of the functions it calls (where tainted
 * values go) and callers of the functions it defines (where values come from). Bounded by files and bytes.
 */
export function callContext(source: ReviewSource, files: readonly CodeFile[], maxBytes = 8000, maxFiles = 3): ReviewSource[] {
  const result: ReviewSource[] = [];
  let bytes = 0;
  const others = files.filter(file => file.path !== source.path);
  const add = (file: CodeFile, snippet?: {startLine: number; text: string}): void => {
    if (!snippet || !snippet.text.trim() || result.length >= maxFiles || result.some(r => r.path === file.path)) return;
    const size = Buffer.byteLength(file.path + snippet.text, "utf8");
    if (bytes + size > maxBytes) return;
    bytes += size;
    result.push({path: file.path, text: snippet.text, startLine: snippet.startLine});
  };
  for (const name of calledNames(source.text)) {
    const file = others.find(f => definedNames(f.text).has(name));
    if (file) add(file, definitionSnippet(file.text, name));
    if (result.length >= maxFiles) return result;
  }
  for (const name of [...definedNames(source.text)].filter(n => n.length >= 4 && !/^(?:main|init|constructor|toString|equals|hashCode|get|set|run)$/.test(n))) {
    const file = others.find(f => !result.some(r => r.path === f.path) && callerSnippet(f.text, name));
    if (file) add(file, callerSnippet(file.text, name));
    if (result.length >= maxFiles) break;
  }
  return result;
}
