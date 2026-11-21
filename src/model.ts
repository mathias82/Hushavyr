import {totalmem} from "node:os";
import {LocalOllama} from "./ollama";

/** Larger local models review noticeably better, but must fit in memory. Qwen3-Coder 30b is a mixture of experts
 * (about 3B active parameters), so it is both stronger and much faster than a dense 32b model. */
export function recommendedModel(memoryBytes: number): string {
  const gb = memoryBytes / 1024 ** 3;
  return gb >= 30 ? "qwen3-coder:30b" : gb >= 20 ? "qwen2.5-coder:14b" : gb >= 12 ? "qwen2.5-coder:7b" : "qwen2.5-coder:3b";
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
