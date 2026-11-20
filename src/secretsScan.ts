/** Local deterministic credential checks. Never returns secret values. */
export interface SecretFinding {line: number; rule: string; severity: "HIGH" | "MEDIUM"}
const ASSIGNMENT = /^\s*(?:export\s+)?(?:["']?)([A-Za-z][A-Za-z0-9_.-]*)(?:["']?)\s*[:=]\s*(.*?)\s*[,;]?\s*$/;
const KEY = /(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|client[_-]?secret|private[_-]?key)/i;
const PLACEHOLDER = /^(?:["']?)(?:|\$\{[^}]+\}|\$[A-Za-z_][\w]*|<[^>]+>|\{\{.*\}\}|changeme|replace[_-]?me|your[_-].*|null|none|undefined|false|true|\*+)(?:["']?)$/i;
export function scanSecrets(content: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    if (index >= 10000 || findings.length >= 100) break;
    if (/^\s*(?:#|\/\/|\*)/.test(line)) continue;
    const match = ASSIGNMENT.exec(line);
    if (!match || !KEY.test(match[1])) continue;
    const value = match[2].trim().replace(/[,;]\s*$/, "").trim();
    // GitHub Actions expressions and template variable references are not literal credentials.
    if (/^["\x27]?\s*\$\{\{\s*(?:secrets|vars|env|github|inputs|steps|needs)\.[^}]+\}\}\s*["\x27]?$/.test(value)) continue;
    if (/^["\x27]?\s*\$\{[A-Za-z_][\w.:-]*\}\s*["\x27]?$/.test(value)) continue;
    if (PLACEHOLDER.test(value) || /^["']\s*["']$/.test(value)) continue;
    findings.push({line: index + 1, rule: "Potential hardcoded credential", severity: "HIGH"});
  }
  return findings;
}
