/**
 * Python rewritten into the brace form the taint engine walks, keeping every line on its original line number:
 * indentation blocks become { } (a match case ends with break, as Python cases do not fall through), strings become
 * double-quoted literals on one line (an f-string becomes the concatenation of its parts), comments are dropped,
 * a "with A as b" binds b = A, and Python operators get their C-family spelling (and → &&, not in → notin, x if c else y → c ? x : y).
 */
export function pythonToBraces(source: string): string {
  const lines = source.split(/\r?\n/), text = lines.join("\n"), out = lines.map(() => "");
  const strings: string[] = [];
  const logical: {line: number; code: string}[] = [];
  let code = "", start = -1, level = 0, line = 0;
  for (let i = 0; i < text.length;) {
    const ch = text[i];
    if (ch === "\n") {
      line++; i++;
      if (level > 0) { code += " "; continue; }
      if (code.endsWith("\\")) { code = code.slice(0, -1) + " "; continue; }
      if (code.trim()) logical.push({line: start, code});
      code = ""; start = -1;
      continue;
    }
    if (start < 0 && /\S/.test(ch)) start = line;
    if (ch === "#") { while (i < text.length && text[i] !== "\n") i++; continue; }
    if (STRING.test(text.slice(i, i + 5)) && !/[\w]/.test(text[i - 1] ?? "")) {
      const s = readString(text, i, strings);
      line += (text.slice(i, s.end).match(/\n/g) ?? []).length;
      code += s.value; i = s.end;
      continue;
    }
    if ("([{".includes(ch)) level++;
    else if (")]}".includes(ch)) level = Math.max(0, level - 1);
    code += ch; i++;
  }
  if (code.trim()) logical.push({line: start < 0 ? line : start, code});

  // An if block that always leaves (return, raise, continue, break, abort) and has no else is a guard: after it, the
  // condition is known to be false, which the engine reads from a __validated__(condition) marker.
  const blocks: {indent: number; kind: "brace" | "case"; guard?: string; exits: boolean}[] = [];
  let previous = -1;
  const close = (indent: number, next: string) => {
    while (blocks.length && indent <= blocks[blocks.length - 1].indent) {
      const b = blocks.pop()!;
      if (previous < 0) continue;
      out[previous] += b.kind === "case" ? "; break" : "; }";
      if (b.guard && b.exits && !(indent === b.indent && /^(?:elif|else)\b/.test(next))) out[previous] += "; __validated__(" + b.guard + ")";
    }
  };
  for (const {line: at, code: raw} of logical) {
    const lead = /^[ \t]*/.exec(lines[at])![0], indent = width(lead), stmt = raw.trim();
    close(indent, stmt);
    const {text: body, opens, guard} = translate(stmt);
    out[at] = lead + body;
    if (blocks.length) blocks[blocks.length - 1].exits = !opens && EXIT.test(stmt);
    if (opens) blocks.push({indent, kind: opens, guard, exits: false});
    previous = at;
  }
  close(-1, "");
  const resolve = (s: string): string => s.replace(/\x01(\d+)\x01/g, (_, n: string) => resolve(strings[+n]));
  // Adjacent literals ("a" f"{b}") are one implicitly concatenated string.
  return out.map(l => resolve(l.replace(/(\x01\d+\x01)(?=\s*\x01)/g, "$1 +"))).join("\n");
}

const EXIT = /^(?:return|raise|continue|break)\b|^(?:[\w.]*\.)?(?:abort|exit)\s*\(/;
const STRING = /^(?:[rRbBuUfF]{1,2})?(?:'''|"""|'|")/;
const width = (lead: string) => [...lead].reduce((w, c) => c === "\t" ? w + 8 - (w % 8) : w + 1, 0);

/** A string literal at i: its end and its translated value (a placeholder into strings). */
function readString(text: string, i: number, strings: string[]): {end: number; value: string} {
  const m = /^([rRbBuUfF]{0,2})('''|"""|'|")/.exec(text.slice(i, i + 5))!;
  const f = /f/i.test(m[1]), quote = m[2], parts: string[] = [];
  let j = i + m[0].length, lit = "";
  const placeholder = (s: string) => "\x01" + (strings.push(s) - 1) + "\x01";
  while (j < text.length) {
    if (text.startsWith(quote, j)) { j += quote.length; break; }
    const c = text[j];
    if (c === "\\") { if (text[j + 1] !== "\n") lit += text.slice(j, j + 2); j += 2; continue; }
    if (quote.length === 1 && c === "\n") break;
    if (f && c === "{" && text[j + 1] === "{") { lit += "{"; j += 2; continue; }
    if (f && c === "}" && text[j + 1] === "}") { lit += "}"; j += 2; continue; }
    if (f && c === "{") {
      let k = j + 1, d = 0, end = -1;
      while (k < text.length) {
        const c2 = text[k];
        if (STRING.test(text.slice(k, k + 5)) && !/\w/.test(text[k - 1])) { k = readString(text, k, strings).end; continue; }
        if ("([{".includes(c2)) d++;
        else if (")]}".includes(c2)) { if (d === 0) break; d--; }
        else if (d === 0 && end < 0 && (c2 === ":" || (c2 === "!" && text[k + 1] !== "="))) end = k;
        k++;
      }
      parts.push(placeholder(quoted(lit)));
      lit = "";
      parts.push("(" + expression(text.slice(j + 1, end < 0 ? k : end).replace(/=\s*$/, ""), strings) + ")");
      j = k + 1;
      continue;
    }
    lit += c; j++;
  }
  if (!parts.length) return {end: j, value: placeholder(quoted(lit))};
  if (lit) parts.push(placeholder(quoted(lit)));
  return {end: j, value: placeholder("(" + parts.join(" + ") + ")")};
}

function quoted(lit: string): string {
  let s = "";
  for (let k = 0; k < lit.length; k++) {
    const c = lit[k];
    if (c === "\\") { s += lit.slice(k, k + 2).replace("\n", "n"); k++; }
    else s += c === "\"" ? "\\\"" : c === "\n" ? "\\" + "n" : c;
  }
  return "\"" + s + "\"";
}

/** An expression from inside an f-string, with its own strings translated. */
function expression(src: string, strings: string[]): string {
  let code = "";
  for (let i = 0; i < src.length;) {
    if (STRING.test(src.slice(i, i + 5)) && !/\w/.test(src[i - 1] ?? "")) { const s = readString(src, i, strings); code += s.value; i = s.end; }
    else code += src[i++];
  }
  return operators(code.replace(/\s+/g, " "));
}

function operators(code: string): string {
  return code.replace(/(?<![\w.])not\s+in(?!\w)/g, "notin").replace(/(?<![\w.])is\s+not(?!\w)/g, "!=").replace(/(?<![\w.])is(?!\w)/g, "==")
    .replace(/(?<![\w.])and(?!\w)/g, "&&").replace(/(?<![\w.])or(?!\w)/g, "||").replace(/(?<![\w.])not(?!\w)\s*/g, "!")
    .replace(/(?<![\w.])True(?!\w)/g, "true").replace(/(?<![\w.])False(?!\w)/g, "false").replace(/(?<![\w.])None(?!\w)/g, "null");
}

/** Positions of top-level (bracket depth 0) matches of re in code. */
function topLevel(code: string, re: RegExp): RegExpExecArray[] {
  const found: RegExpExecArray[] = [];
  let d = 0;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if ("([{".includes(ch)) d++;
    else if (")]}".includes(ch)) d--;
    else if (d === 0) { re.lastIndex = i; const m = re.exec(code); if (m && m.index === i) found.push(m); }
  }
  return found;
}

/** A if C else B (top level) becomes (C) ? (A) : (B). */
function conditional(expr: string): string {
  const ifs = topLevel(expr, /(?<![\w.])if(?!\w)/y), elses = topLevel(expr, /(?<![\w.])else(?!\w)/y);
  if (!ifs.length) return expr;
  const els = elses.find(e => e.index > ifs[0].index);
  if (!els || /(?<![\w.])(?:for|lambda)(?!\w)/.test(expr.slice(0, ifs[0].index))) return expr;
  const a = expr.slice(0, ifs[0].index).trim(), c = expr.slice(ifs[0].index + 2, els.index).trim(), b = expr.slice(els.index + 4).trim();
  return "(" + c + ") ? (" + a + ") : (" + conditional(b) + ")";
}

/** One statement: a block header becomes its brace form (opens says what block it starts); other statements get Python operators translated. */
function translate(stmt: string): {text: string; opens?: "brace" | "case"; guard?: string} {
  const kw = /^(if|elif|else|for|async\s+for|while|try|except\*?|finally|with|async\s+with|def|async\s+def|class|match|case)(?!\w)/.exec(stmt);
  const colon = kw ? topLevel(stmt, /:/y).find(m => stmt[m.index + 1] !== "=") : undefined;
  // match and case are soft keywords: "match = ..." or "match.group(1)" are ordinary statements.
  if (kw && colon && !/^(?:match|case)\s*[=.,)\]]/.test(stmt)) {
    const head = stmt.slice(kw[0].length, colon.index).trim(), rest = stmt.slice(colon.index + 1).trim();
    const key = kw[1].replace(/\s+/g, " ");
    let open: string, kind: "brace" | "case" = "brace";
    if (key === "if") open = "if (" + operators(head) + ") {";
    else if (key === "elif") open = "else if (" + operators(head) + ") {";
    else if (key === "else") open = "else {";
    else if (key === "for" || key === "async for") open = "for (" + operators(head) + ") {";
    else if (key === "while") open = "while (" + operators(head) + ") {";
    else if (key === "try") open = "try {";
    else if (key.startsWith("except")) open = "catch (" + head + ") {";
    else if (key === "finally") open = "finally {";
    else if (key === "with" || key === "async with") {
      const items = split(head.replace(/^\((.*)\)$/, "$1"));
      open = items.map(item => { const as = /^(.*?)\s+as\s+([A-Za-z_]\w*)$/.exec(item.trim()); return as ? as[2] + " = " + operators(as[1]) + "; " : operators(item) + "; "; }).join("") + "do {";
    } else if (key === "def" || key === "async def") open = (key === "async def" ? "async " : "") + "def " + head.replace(/\)\s*->[\s\S]*$/, ")") + " {";
    else if (key === "class") open = "do {";
    else if (key === "match") open = "switch (" + operators(head) + ") {";
    else { kind = "case"; open = head === "_" ? "default:" : "case " + head + ":"; }
    const guard = key === "if" ? operators(head) : undefined;
    if (!rest) return {text: open, opens: kind, guard};
    return {text: open + " " + statement(rest) + (kind === "case" ? "; break" : "; }") + (guard && EXIT.test(rest) ? "; __validated__(" + guard + ")" : "")};
  }
  return {text: statement(stmt)};
}

function statement(stmt: string): string {
  return split(stmt, ";").map(s => {
    const t = s.trim();
    if (/^(?:pass|global\b.*|nonlocal\b.*)$/.test(t)) return "";
    if (/^raise\b/.test(t)) return "throw" + operators(t.slice(5));
    if (/^return\b/.test(t)) return "return " + conditional(operators(t.slice(6).trim()));
    const annotated = /^([A-Za-z_][\w.]*)\s*:\s*[^=]+?(?:=(?!=)\s*([\s\S]*))?$/.exec(t);
    if (annotated && !/^(?:lambda|else|try|finally)$/.test(annotated[1])) return annotated[2] === undefined ? "" : annotated[1] + " = " + conditional(operators(annotated[2]));
    const eq = topLevel(t, /(?<![=!<>+\-*/%&|^@:])=(?!=)/y)[0];
    if (eq) return t.slice(0, eq.index).trimEnd() + " = " + conditional(operators(t.slice(eq.index + 1).trim()));
    return operators(t);
  }).join("; ");
}

function split(text: string, sep = ","): string[] {
  const parts: string[] = [];
  let last = 0;
  for (const m of topLevel(text, new RegExp(sep, "y"))) { parts.push(text.slice(last, m.index)); last = m.index + 1; }
  parts.push(text.slice(last));
  return parts;
}
