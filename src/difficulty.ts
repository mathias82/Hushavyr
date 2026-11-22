import { ReviewResult } from "./review";

/** Why the local model's answer may be unreliable; drives an opt-in escalation suggestion, never an automatic send. */
export interface Difficulty { hard: boolean; reasons: string[] }

const CONCURRENCY = /\b(synchronized|volatile|Thread|Executor|CompletableFuture|Mutex|RWMutex|WaitGroup|chan\s|go\s+func|goroutine|asyncio|threading|Lock\(|Semaphore|Atomic\w+|Promise\.all|Interlocked|ConcurrentHashMap)\b/;

/** Long, deeply nested or concurrent code where an empty local review is less trustworthy. */
export function complexity(code: string): string | undefined {
  const lines = code.split(/\r?\n/).filter(l => l.trim()).length;
  if (CONCURRENCY.test(code)) return "concurrent code";
  let depth = 0, max = 0;
  for (const ch of code.replace(/"(?:[^"\x5c\n]|\x5c.)*"|'(?:[^'\x5c\n]|\x5c.)*'/g, "")) {
    if (ch === "{") max = Math.max(max, ++depth);
    else if (ch === "}") depth = Math.max(0, depth - 1);
  }
  if (max >= 6) return "deeply nested code";
  if (lines >= 120) return "long code (" + lines + " lines)";
  return undefined;
}

export function reviewDifficulty(result: ReviewResult | undefined, code: string): Difficulty {
  const reasons: string[] = [];
  if (!result || result.error || result.retryFailed) reasons.push("the local answer was unusable");
  else {
    if (result.verifierFailed) reasons.push("the second local pass could not check the findings");
    if (result.verifierRejected) reasons.push("the second local pass rejected " + result.verifierRejected + " finding(s)");
    if (result.rejected) reasons.push(result.rejected + " finding(s) had no matching evidence in the code");
    const complex = complexity(code);
    if (!result.findings.length && complex) reasons.push("no findings in " + complex);
  }
  return {hard: reasons.length > 0, reasons};
}

const HEDGING = /\b(I(?:'m| am) not (?:sure|certain)|cannot (?:determine|tell|be certain)|can't (?:determine|tell)|unclear (?:from|whether)|without (?:more|additional) context|it(?:'s| is) (?:hard|difficult) to (?:say|tell))\b|δεν (?:είμαι|ειμαι) σίγουρ|δεν μπορώ να (?:πω|ξέρω|καταλάβω)/i;
const DOUBT = /\b(are you sure|that'?s wrong|is that right|not correct|incorrect|wrong answer)\b|σίγουρ|λάθος|δεν (?:είναι|ισχύει) σωστ|sigour|lathos/i;

/** Prose answers: hedging in the answer, a doubting follow-up, or an empty/failed answer. */
export function answerDifficulty(answer: string | undefined, question: string): Difficulty {
  const reasons: string[] = [];
  if (!answer?.trim()) reasons.push("the local model gave no answer");
  else if (HEDGING.test(answer)) reasons.push("the local model said it is unsure");
  if (DOUBT.test(question)) reasons.push("you doubted the previous answer");
  return {hard: reasons.length > 0, reasons};
}

/** The part of the code to offer for escalation: all of it if small, else a window around a line, else nothing. */
export function escalationFragment(code: string, startLine = 1, line?: number, max = 4000): {code: string; startLine: number} | undefined {
  if (code.trim() && code.length <= max) return {code, startLine};
  if (line === undefined) return undefined;
  const lines = code.split(/\r?\n/);
  const center = line - startLine;
  if (center < 0 || center >= lines.length) return undefined;
  let from = center, to = center;
  // Grow symmetrically while the window fits.
  while (from > 0 || to < lines.length - 1) {
    const nextFrom = Math.max(0, from - 1), nextTo = Math.min(lines.length - 1, to + 1);
    if (lines.slice(nextFrom, nextTo + 1).join("\n").length > max) break;
    from = nextFrom; to = nextTo;
  }
  const text = lines.slice(from, to + 1).join("\n");
  return text.trim() && text.length <= max ? {code: text, startLine: startLine + from} : undefined;
}
