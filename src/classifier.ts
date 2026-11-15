export type Route = "local" | "cloud-eligible";
export interface Decision { route: Route; reasons: string[] }

const patterns: Array<[string, RegExp]> = [
  ["credential", /(?:api[_-]?key|password|client[_-]?secret|private[_-]?key)\s*[:=]\s*[^\s"'\x60]{4,}/i],
  ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["confidential-marker", /\b(?:confidential|strictly private|internal only|εμπιστευτικ[όά])\b/i],
];

/** Fail closed: this heuristic cannot certify that content is safe for cloud. */
export function classify(text: string): Decision {
  const reasons = patterns.filter(([, regex]) => regex.test(text)).map(([reason]) => reason);
  if (!text.trim()) reasons.push("empty-context");
  if (reasons.length === 0) reasons.push("unverified-sensitivity");
  return { route: "local", reasons };
}
