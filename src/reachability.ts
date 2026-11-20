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
