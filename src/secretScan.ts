/** Deterministic local-only credential checks. Never return secret values. */
export interface SecretFinding {line: number; rule: string; severity: "HIGH" | "MEDIUM"}
const sensitiveKey = /(?:PASSWORD|PASSWD|SECRET|TOKEN|API[_-]?KEY|PRIVATE[_-]?KEY|CLIENT[_-]?SECRET|ACCESS[_-]?KEY)/i;
const placeholder = /^(?:\$\{[^}]+\}|\{\{[^}]+\}\}|<[^>]+>|(?:changeme|replace_me|your[_-].*|example|placeholder|dummy|test|none|null))$/i;
export function scanSecrets(path: string, source: string): SecretFinding[] {
  const result: SecretFinding[] = [];
  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length && i < 20000; i++) {
    const line = lines[i];
    if (/^\s*(?:#|\/\/|\*|;)/.test(line)) continue;
    // .env, properties, YAML and common JS/Java/Python assignments.
    const match = line.match(/^\s*["']?([A-Za-z_][\w.-]*)["']?\s*(?:=|:)\s*(.+?)\s*[,;]?\s*$/);
    if (!match || !sensitiveKey.test(match[1])) continue;
    const value = match[2].trim().replace(/[,;]\s*$/, "").replace(/^["']|["']$/g, "").trim();
    if (!value || placeholder.test(value) || /^(?:process\.env\.|os\.environ|System\.getenv|env\(|\$\{)/.test(value)) continue;
    result.push({line: i + 1, rule: "Potential hardcoded credential", severity: "HIGH"});
    if (result.length >= 200) break;
  }
  return result;
}
