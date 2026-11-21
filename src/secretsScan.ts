/** Local deterministic credential checks. Never returns secret values. */
export interface SecretFinding {line: number; rule: string; severity: "HIGH" | "MEDIUM"}
const ASSIGNMENT = /^\s*(?:export\s+)?(?:["']?)([A-Za-z][A-Za-z0-9_.-]*)(?:["']?)\s*[:=]\s*(.*?)\s*[,;]?\s*$/;
const KEY = /(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|client[_-]?secret|private[_-]?key)/i;
const PLACEHOLDER = /^(?:["']?)(?:|\$\{[^}]+\}|\$[A-Za-z_][\w]*|<[^>]+>|\{\{.*\}\}|changeme|replace[_-]?me|your[_-].*|null|none|undefined|false|true|\*+)(?:["']?)$/i;
// Code declarations such as `const password = "..."` or `private static final String API_KEY = "...";` need a literal value.
const CODE_ASSIGNMENT = /^\s*(?:(?:export|const|let|var|final|private|public|protected|static|readonly|val)\s+)+(?:[A-Za-z_][\w<>\[\],.?]*\s+)?([A-Za-z_]\w*)\s*(?::\s*[\w<>\[\]]+\s*)?=\s*(["'])([^"']{4,})\2\s*;?\s*$/;
// File globs such as "**/*.{env,yml}" name files that may hold secrets; they are not secrets.
const GLOB = /\*\*?\/|\*\.|\{[\w.-]*(?:,[\w.-]*)+\}/;
export function scanSecrets(content: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    if (index >= 10000 || findings.length >= 100) break;
    if (/^\s*(?:#|\/\/|\*)/.test(line)) continue;
    const code = CODE_ASSIGNMENT.exec(line);
    if (code && KEY.test(code[1]) && !PLACEHOLDER.test(code[2] + code[3] + code[2]) && !/^\$\{|^\{\{|^<.*>$/.test(code[3]) && !GLOB.test(code[3])) {
      findings.push({line: index + 1, rule: "Potential hardcoded credential", severity: "HIGH"});
      continue;
    }
    const match = ASSIGNMENT.exec(line);
    if (!match || !KEY.test(match[1])) continue;
    const value = match[2].trim().replace(/[,;]\s*$/, "").trim();
    // GitHub Actions expressions and template variable references are not literal credentials.
    if (/^["\x27]?\s*\$\{\{\s*(?:secrets|vars|env|github|inputs|steps|needs)\.[^}]+\}\}\s*["\x27]?$/.test(value)) continue;
    if (/^["\x27]?\s*\$\{[A-Za-z_][\w.:-]*\}\s*["\x27]?$/.test(value)) continue;
    if (PLACEHOLDER.test(value) || /^["']\s*["']$/.test(value) || GLOB.test(value)) continue;
    findings.push({line: index + 1, rule: "Potential hardcoded credential", severity: "HIGH"});
  }
  return findings;
}
