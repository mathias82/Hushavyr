/**
 * Import-level reachability for dependency CVEs: is the vulnerable package imported by project source at all?
 * This does not prove the vulnerable function is called; "not imported" usually means a transitive or unused
 * dependency and is a reason to lower priority, never to ignore a finding.
 */
export type Reachability = "imported" | "not-imported" | "unknown";

/** Module names a source file imports (Java/Kotlin packages, JS/TS packages, Python modules, Go paths). */
export function collectImports(path: string, text: string): string[] {
  const found: string[] = [];
  if (/\.(?:java|kt|scala|groovy)$/.test(path)) {
    for (const m of text.matchAll(/^\s*import\s+(?:static\s+)?([\w.]+)/gm)) found.push(m[1]);
  } else if (/\.(?:[cm]?[jt]sx?)$/.test(path)) {
    for (const m of text.matchAll(/(?:from\s+|import\s*\(?\s*|require\(\s*|import\s+)["']([^"'./][^"']*)["']/g)) found.push(m[1]);
  } else if (/\.py$/.test(path)) {
    for (const m of text.matchAll(/^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+(?:\s*,\s*[\w.]+)*))/gm)) {
      if (m[1]) found.push(m[1]); else found.push(...m[2].split(/\s*,\s*/));
    }
  } else if (/\.go$/.test(path)) {
    const block = /import\s*\(([\s\S]*?)\)/.exec(text)?.[1] ?? "";
    for (const m of (block + "\n" + text).matchAll(/(?:^|\s)(?:\w+\s+)?"([\w.\-/]+)"/gm)) found.push(m[1]);
  }
  return found;
}

// Distribution name -> import name where they differ.
const PY_ALIASES: Record<string, string> = {
  pyyaml: "yaml", beautifulsoup4: "bs4", pillow: "PIL", "python-dateutil": "dateutil", "scikit-learn": "sklearn",
  "opencv-python": "cv2", protobuf: "google.protobuf", "psycopg2-binary": "psycopg2", pyjwt: "jwt",
  "python-jose": "jose", pycryptodome: "Crypto", "msgpack-python": "msgpack", pymysql: "pymysql"
};

/** Whether a vulnerable package is imported by any collected import; ecosystem comes from the Trivy target or manager. */
export function reachability(pkg: string, ecosystem: string, imports: ReadonlySet<string>): Reachability {
  if (!imports.size) return "unknown";
  const list = [...imports];
  const eco = ecosystem.toLowerCase();
  if (/pom\.xml|gradle|maven|\.jar/.test(eco) || /^[\w.-]+:[\w.-]+$/.test(pkg)) {
    const [group, artifact = ""] = pkg.split(":");
    const parts = group.split(".");
    const prefix = parts.slice(0, Math.min(3, parts.length)).join(".");
    const artifactPackage = group + "." + artifact.replace(/-/g, ".");
    return list.some(i => i.startsWith(prefix + ".") || i.startsWith(artifactPackage) || i === prefix) ? "imported" : "not-imported";
  }
  if (/package(?:-lock)?\.json|yarn|pnpm|npm|node/.test(eco)) {
    return list.some(i => i === pkg || i.startsWith(pkg + "/")) ? "imported" : "not-imported";
  }
  if (/requirements|poetry|pipfile|pip|python|\.py/.test(eco)) {
    const key = pkg.toLowerCase();
    const name = PY_ALIASES[key] ?? key.replace(/-/g, "_");
    return list.some(i => i.toLowerCase() === name.toLowerCase() || i.toLowerCase().startsWith(name.toLowerCase() + ".")) ? "imported" : "not-imported";
  }
  if (/go\.(?:mod|sum)|gomod|\bgo\b/.test(eco)) {
    return list.some(i => i === pkg || i.startsWith(pkg + "/")) ? "imported" : "not-imported";
  }
  return "unknown";
}

/** Well-known vulnerable entry points the advisory title rarely names. Keys are package names (lower case). */
const KNOWN_SYMBOLS: Record<string, string[]> = {
  "lodash": ["template", "merge", "mergeWith", "defaultsDeep", "zipObjectDeep", "set", "setWith"],
  "lodash.template": ["template"], "lodash.merge": ["merge"], "lodash.set": ["set"],
  "minimist": ["minimist"], "jsonwebtoken": ["verify", "decode"], "xml2js": ["parseString", "parseStringPromise"],
  "node-serialize": ["unserialize"], "serialize-javascript": ["serialize"], "ejs": ["render", "renderFile", "compile"],
  "pyyaml": ["load", "full_load", "unsafe_load"], "pickle": ["loads", "load"], "jinja2": ["from_string", "Template"],
  "com.fasterxml.jackson.core:jackson-databind": ["enableDefaultTyping", "activateDefaultTyping"],
  "org.yaml:snakeyaml": ["load", "loadAll", "loadAs"],
  "org.apache.commons:commons-text": ["StringSubstitutor", "createInterpolator"],
  "commons-collections:commons-collections": ["InvokerTransformer"],
  "org.apache.logging.log4j:log4j-core": ["JndiLookup", "lookup"]
};
// Packages whose advisories almost all go through the same entry points, so the list applies even when the title names none.
const ALWAYS = new Set(["pyyaml", "node-serialize", "com.fasterxml.jackson.core:jackson-databind", "org.yaml:snakeyaml", "commons-collections:commons-collections"]);
const PROSE = new Set(["e.g", "i.e", "etc", "vs"]);

/** Function/class names a vulnerability is about: the curated list plus code-looking words in the advisory title. */
export function vulnerableSymbols(pkg: string, title: string): string[] {
  const known = KNOWN_SYMBOLS[pkg.toLowerCase()] ?? [];
  const words = new Set(title.toLowerCase().match(/[a-z_]\w*/g) ?? []);
  const found = new Set(ALWAYS.has(pkg.toLowerCase()) ? known : known.filter(s => words.has(s.toLowerCase())));
  for (const m of title.matchAll(/\b([a-z]+[A-Z]\w*|[a-z]+_[a-z_]+|[A-Za-z_]\w*\.[a-z_]\w*)(?:\(\))?/g)) {
    const word = m[1].includes(".") ? m[1].split(".").pop()! : m[1];
    if (word.length >= 4 && !PROSE.has(m[1].toLowerCase()) && !/^\d/.test(word)) found.add(word);
  }
  return [...found];
}

export interface SymbolCall { path: string; line: number; symbol: string }

/** First call (or construction) of a vulnerable symbol in a file that imports the package; undefined when none is visible. */
export function findVulnerableCall(pkg: string, ecosystem: string, symbols: readonly string[], files: readonly {path: string; text: string}[]): SymbolCall | undefined {
  if (!symbols.length) return undefined;
  const call = new RegExp("(?:^|[^\\w$])(?:new\\s+)?(" + symbols.map(s => s.replace(/[^\w$]/g, "")).join("|") + ")\\s*[(<]");
  for (const file of files) {
    if (reachability(pkg, ecosystem, new Set(collectImports(file.path, file.text))) !== "imported") continue;
    const lines = file.text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*(?:import|from|\/\/|#|\*)/.test(lines[i])) continue;
      const m = call.exec(lines[i]);
      if (m) return {path: file.path, line: i + 1, symbol: m[1]};
    }
  }
  return undefined;
}
