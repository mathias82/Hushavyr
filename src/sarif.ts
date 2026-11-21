/** Minimal SARIF 2.1.0 writer: GitHub code scanning, Azure DevOps and IDE SARIF viewers read this format. */
export interface SarifResult { ruleId: string; message: string; path: string; line: number; level: "error" | "warning" | "note" }

export function sarifLevel(severity: string): SarifResult["level"] {
  return /^(?:high|critical|error)$/i.test(severity) ? "error" : /^(?:medium|warning|moderate)$/i.test(severity) ? "warning" : "note";
}

export function toSarif(results: readonly SarifResult[], version: string): object {
  const rules = [...new Set(results.map(r => r.ruleId))];
  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [{
      tool: {driver: {name: "Hushavyr", version, informationUri: "https://github.com/mathias82/Hushavyr",
        rules: rules.map(id => ({id, shortDescription: {text: id}}))}},
      results: results.map(r => ({
        ruleId: r.ruleId, ruleIndex: rules.indexOf(r.ruleId), level: r.level, message: {text: r.message},
        locations: [{physicalLocation: {artifactLocation: {uri: r.path.replace(/\\/g, "/").replace(/^\.\//, "")},
          region: {startLine: Math.max(1, Math.trunc(r.line))}}}]
      }))
    }]
  };
}

const CANONICAL: Array<[RegExp, string]> = [
  [/sql-(?:concatenation|formatting)$/, "sql-string-concatenation"],
  [/shell-execution$|runtime-exec$|child-process-exec$/, "potential-command-execution"],
  [/^(?:js|python)-eval$/, "unsafe-dynamic-code-evaluation"],
  [/^python-unsafe-deserialization$/, "unsafe-python-deserialization"],
  [/insecure-tls$|tls-disabled$|insecure-trust-manager$/, "tls-certificate-validation-disabled"],
  [/^weak-hash(?:-\w+)?$/, "weak-cryptographic-hash"]
];
/** One rule id per weakness, whether the bundled Semgrep pack or the built-in rules found it. */
export function canonicalRule(id: string): string {
  return CANONICAL.find(([rx]) => rx.test(id))?.[1] ?? id;
}
