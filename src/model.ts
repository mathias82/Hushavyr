import {totalmem} from "node:os";

/** Larger local models review noticeably better, but must fit in memory. */
export function recommendedModel(memoryBytes: number): string {
  const gb = memoryBytes / 1024 ** 3;
  return gb >= 48 ? "qwen2.5-coder:32b" : gb >= 20 ? "qwen2.5-coder:14b" : "qwen2.5-coder:7b";
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
