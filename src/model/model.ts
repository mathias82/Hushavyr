import {totalmem} from "node:os";
import {LocalOllama} from "./ollama";

/** Larger local models review noticeably better, but must fit in memory. Qwen3-Coder 30b is a mixture of experts
 * (about 3B active parameters), so it is both stronger and much faster than a dense 32b model. */
export function recommendedModel(memoryBytes: number): string {
  const gb = memoryBytes / 1024 ** 3;
  return gb >= 30 ? "qwen3-coder:30b" : gb >= 20 ? "qwen2.5-coder:14b" : gb >= 12 ? "qwen2.5-coder:7b" : "qwen2.5-coder:3b";
}

/** The stronger local model that re-judges only the findings the smaller model's own checks disagree on. */
export const JUDGE_MODEL = "qwen2.5-coder:32b";
/** True when the main model is smaller than the judge and the machine can hold the judge (about 20 GB). */
export function judgeFits(model: string, memoryBytes = totalmem()): boolean {
  const size = Number(/:(\d+(?:\.\d+)?)b\b/i.exec(model)?.[1]);
  return memoryBytes / 1024 ** 3 >= 22 && Number.isFinite(size) && size < 32;
}
/** The judge client when the setting allows it, it fits and it is already installed (never downloaded implicitly). */
export async function localJudge(client: LocalOllama, model: string, setting = "auto", memoryBytes = totalmem(), signal?: AbortSignal): Promise<LocalOllama | undefined> {
  if (setting === "off" || !judgeFits(model, memoryBytes)) return undefined;
  const installed = await client.listModels(signal).catch(() => [] as string[]);
  return installed.includes(JUDGE_MODEL) ? client.withModel(JUDGE_MODEL, 600_000) : undefined;
}

/** Review passes that fit the machine: several focused passes need memory and time that 8 GB laptops do not have. */
export function autoDepth(memoryBytes = totalmem()): "thorough" | "fast" | "light" {
  const gb = memoryBytes / 1024 ** 3;
  return gb >= 20 ? "thorough" : gb >= 12 ? "fast" : "light";
}

/** The reviewDepth setting; "auto" (the default) follows the machine's memory. */
export function configuredDepth(config: Pick<ModelConfig, "get">, memoryBytes = totalmem()): "thorough" | "fast" | "light" {
  const value = config.get<string>("reviewDepth", "auto");
  return value === "thorough" || value === "fast" || value === "light" ? value : autoDepth(memoryBytes);
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
