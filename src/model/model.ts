import {totalmem} from "node:os";
import {LocalOllama} from "./ollama";

/** Larger local models review noticeably better, but must fit in memory. Qwen3-Coder 30b is a mixture of experts
 * (about 3B active parameters), so it is both stronger and much faster than a dense 32b model. Measured on a 24 GB Mac:
 * it uses about 20 GB and reviews a benchmark case in 6 s (14b: 12 s). */
export function recommendedModel(memoryBytes: number): string {
  const gb = memoryBytes / 1024 ** 3;
  return gb >= 24 ? "qwen3-coder:30b" : gb >= 20 ? "qwen2.5-coder:14b" : gb >= 12 ? "qwen2.5-coder:7b" : "qwen2.5-coder:3b";
}

/** How the second local pass checks a model's findings, measured on the 120-fixture benchmark: a full skeptical pass ("batch")
 * suits 14b and larger; 7b and smaller reject their own real bugs in it (7b: P 1.00 R 0.16), so only hedged findings
 * ("Potential ...", "may ...") are checked (7b: P 0.83 R 0.49, versus P 0.45 R 0.61 with no check). 30b and larger need no second pass: on the 96 tuned fixtures
 * qwen3-coder:30b scored P 0.78 R 0.92 in 6 s per case without it, versus P 0.80 R 0.82 in 13 s with it. */
export function verifyModeFor(model: string): "batch" | "hedged" | "none" {
  const size = Number(/:(\d+(?:\.\d+)?)b\b/i.exec(model)?.[1]);
  return Number.isFinite(size) && size <= 8 ? "hedged" : size >= 30 ? "none" : "batch";
}

/** The stronger local model that re-judges only the findings the smaller model's own checks disagree on. */
export const JUDGE_MODEL = "qwen2.5-coder:32b";
/** True when the main model is smaller than the judge and the machine can hold it next to the main model
 * (measured: on 24 GB the 32b model alone runs partly on the CPU and a review exceeds 5 minutes). */
export function judgeFits(model: string, memoryBytes = totalmem()): boolean {
  const size = Number(/:(\d+(?:\.\d+)?)b\b/i.exec(model)?.[1]);
  return memoryBytes / 1024 ** 3 >= 48 && Number.isFinite(size) && size < 32;
}
/** The judge client when the setting allows it, it fits and it is already installed (never downloaded implicitly). */
export async function localJudge(client: LocalOllama, model: string, setting = "auto", memoryBytes = totalmem(), signal?: AbortSignal): Promise<LocalOllama | undefined> {
  if (setting === "off" || !judgeFits(model, memoryBytes)) return undefined;
  const installed = await client.listModels(signal).catch(() => [] as string[]);
  return installed.includes(JUDGE_MODEL) ? client.withModel(JUDGE_MODEL, 600_000) : undefined;
}

/** Review passes that fit the machine: several focused passes need memory and time that 8 GB laptops do not have.
 * 30b and larger models use one pass: on the 96 tuned fixtures qwen3-coder:30b found the same bugs with the extra passes
 * but more false positives (P 0.70 versus 0.78) in 2.5 times the time. */
export function autoDepth(memoryBytes = totalmem(), model = ""): "thorough" | "fast" | "light" {
  const gb = memoryBytes / 1024 ** 3;
  const size = Number(/:(\d+(?:\.\d+)?)b\b/i.exec(model)?.[1]);
  return gb >= 20 ? size >= 30 ? "fast" : "thorough" : gb >= 12 ? "fast" : "light";
}

/** The reviewDepth setting; "auto" (the default) follows the machine's memory. */
export function configuredDepth(config: Pick<ModelConfig, "get">, memoryBytes = totalmem(), model = ""): "thorough" | "fast" | "light" {
  const value = config.get<string>("reviewDepth", "auto");
  return value === "thorough" || value === "fast" || value === "light" ? value : autoDepth(memoryBytes, model);
}

interface ModelConfig {
  inspect?(key: string): {globalValue?: unknown; workspaceValue?: unknown; workspaceFolderValue?: unknown} | undefined;
  get<T>(key: string, fallback: T): T;
}
/** The model the user chose, otherwise the best one that fits this machine (the 7b setting default is only a floor). */
export function configuredModel(config: ModelConfig, memoryBytes = totalmem()): string {
  const set = config.inspect?.("ollamaModel");
  const explicit = config.inspect ? set?.workspaceFolderValue ?? set?.workspaceValue ?? set?.globalValue : config.get<string>("ollamaModel", "");
  return typeof explicit === "string" && explicit.trim() ? explicit.trim() : recommendedModel(memoryBytes);
}
/** The configured model, else the best one for this machine if it is downloaded, else a downloaded code model, else the recommendation. */
export function chooseModel(configured: string | undefined, installed: readonly string[], memoryBytes: number): string {
  if (configured?.trim()) return configured.trim();
  const best = recommendedModel(memoryBytes);
  if (!installed.length || installed.includes(best)) return best;
  return CURATED_MODELS.find(m => installed.includes(m)) ?? installed.find(m => /coder|code/i.test(m)) ?? installed[0];
}
/** configuredModel, but without a chosen model an installed one wins over downloading the recommendation
 * (so a larger recommendation after an update never starts a surprise download). */
export async function installedModel(config: ModelConfig, memoryBytes = totalmem(), signal?: AbortSignal): Promise<string> {
  const model = configuredModel(config, memoryBytes);
  if (model !== recommendedModel(memoryBytes)) return model;
  const installed = await configuredClient(config, model, memoryBytes).listModels(signal).catch(() => [] as string[]);
  return chooseModel(undefined, installed, memoryBytes);
}
/** Ollama client from the extension settings (model, loopback endpoint, timeout). */
export function configuredClient(config: ModelConfig, model = configuredModel(config), memoryBytes = totalmem()): LocalOllama {
  return new LocalOllama({model, endpoint: config.get<string>("ollamaEndpoint", "http://127.0.0.1:11434"),
    timeoutMs: config.get<number>("timeoutSeconds", 180) * 1000,
    // A 16k context alone needs gigabytes of KV cache; 8k still fits the 20 KB review limit.
    contextTokens: memoryBytes / 1024 ** 3 < 12 ? 8192 : undefined});
}

export const CURATED_MODELS = ["qwen2.5-coder:7b", "qwen2.5-coder:14b", "qwen3-coder:30b", "qwen2.5-coder:32b", "deepseek-coder-v2:16b"];
/** Setup choices: current and recommended first, then the curated code models, then whatever is already installed locally. */
export function modelChoices(current: string, best: string, installed: readonly string[]): {label: string; tags: string[]}[] {
  const has = new Set(installed);
  return [...new Set([current, best, ...CURATED_MODELS, ...installed])].map(label => ({label,
    tags: [label === best ? "recommended" : "", label === current ? "current" : "", has.has(label) ? "installed" : ""].filter(Boolean)}));
}
/** Ollama model names such as "codestral", "qwen2.5-coder:14b" or "user/model:tag"; cloud models are rejected. */
export const isLocalModelName = (name: string): boolean =>
  /^[a-z0-9][\w.-]*(\/[\w.-]+)?(:[\w.-]+)?$/i.test(name) && !/(?:^|[:/-])cloud(?:$|[:/-])/i.test(name);
