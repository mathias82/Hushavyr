import { LocalOllama } from "../model/ollama";
import { Finding } from "./review";

/**
 * What one review stage proposed, kept or dropped, so the benchmark can tell where a bug was lost.
 * Measurement only: recording never changes prompts, model calls or findings. Kept in memory;
 * only stage names, lines and titles are ever printed, never source text.
 */
export interface Candidate { path?: string; line?: number; endLine?: number; title: string; fix: string; reason?: string }
export interface StageRecord { stage: string; candidates: Candidate[]; error?: string }
type Client = Pick<LocalOllama, "generate">;

export const candidate = (f: Finding): Candidate => ({path: f.path, line: f.line,
  endLine: f.line === undefined ? undefined : f.line + f.evidence.split("\n").length - 1, title: f.title, fix: f.fix});

const unfenced = (raw: string): string => raw.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1] ?? raw;

export class ReviewTrace {
  readonly stages: StageRecord[] = [];
  readonly calls: Record<string, number> = {};
  readonly errors: {stage: string; message: string}[] = [];
  readonly invalidJson: Record<string, number> = {};
  private current = "general";

  /** Model calls from here on are counted under this stage. */
  at(stage: string): void { this.current = stage; }

  record(stage: string, findings: readonly Finding[], error?: string): void {
    this.stages.push({stage, candidates: findings.map(candidate), ...(error ? {error} : {})});
  }

  /** A candidate the validator refused, under "<stage>.rejected". */
  rejected(stage: string, c: Candidate): void {
    const name = stage + ".rejected";
    let entry = this.stages.find(s => s.stage === name);
    if (!entry) this.stages.push(entry = {stage: name, candidates: []});
    entry.candidates.push(c);
  }

  /** Same client, same calls: only counts them and notes failures and unparsable answers. */
  client(inner: Client): Client {
    return {generate: async (prompt, options) => {
      const stage = this.current;
      this.calls[stage] = (this.calls[stage] ?? 0) + 1;
      try {
        const raw = await inner.generate(prompt, options);
        if (options?.schema) { try { JSON.parse(unfenced(raw)); } catch { this.invalidJson[stage] = (this.invalidJson[stage] ?? 0) + 1; } }
        return raw;
      } catch (error) {
        this.errors.push({stage, message: (error instanceof Error ? error.message : String(error)).slice(0, 200)});
        throw error;
      }
    }};
  }
}
