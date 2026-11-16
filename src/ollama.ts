export interface LocalModelConfig { model: string; timeoutMs?: number; endpoint?: string }
export interface OllamaTransport { (url: string, init: RequestInit): Promise<Response> }
export interface GenerateOptions { json?: boolean; schema?: object; signal?: AbortSignal }

export function localEndpoint(value = "http://127.0.0.1:11434"): string {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Ollama endpoint must be a loopback HTTP origin");
  }
  if (url.hostname === "localhost") url.hostname = "127.0.0.1";
  return url.origin;
}

export class LocalOllama {
  private readonly base: string;
  constructor(private readonly config: LocalModelConfig, private readonly transport: OllamaTransport = fetch) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(config.model)) throw new Error("Invalid local model name");
    if (config.timeoutMs !== undefined && (!Number.isFinite(config.timeoutMs) || config.timeoutMs <= 0)) throw new Error("Invalid timeout");
    this.base = localEndpoint(config.endpoint);
  }
  private async request(path: string, init: RequestInit, signal?: AbortSignal): Promise<unknown> {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    if (signal?.aborted) abort();
    signal?.addEventListener("abort", abort, {once: true});
    const timeout = setTimeout(abort, this.config.timeoutMs ?? 120000);
    try {
      const response = await this.transport(this.base + path, {...init, signal: controller.signal, redirect: "error"});
      if (!response.ok) throw new Error("HTTP error");
      return await response.json();
    } catch {
      throw new Error("Local Ollama unavailable or request failed. No cloud fallback.");
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  }
  async ensureAvailable(signal?: AbortSignal): Promise<void> {
    const data = await this.request("/api/tags", {method: "GET"}, signal);
    if (!data || typeof data !== "object" || !("models" in data) || !Array.isArray(data.models)) throw new Error("Invalid local model inventory. No cloud fallback.");
    const expected = this.config.model.includes(":") ? this.config.model : this.config.model + ":latest";
    if (!data.models.some(m => m && typeof m === "object" && (m.name === this.config.model || m.name === expected))) {
      throw new Error("Configured model is not installed locally. Run npm run ai:serve or install it with Ollama. No cloud fallback.");
    }
  }
  async generate(prompt: string, options: GenerateOptions = {}): Promise<string> {
    if (!prompt.trim()) throw new Error("Empty prompt");
    if (options.schema && Buffer.byteLength(prompt, "utf8") > 28000) throw new Error("Structured review prompt exceeds the local context budget");
    if (options.signal?.aborted) throw new Error("Local request cancelled");
    const data = await this.request("/api/generate", {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({model: this.config.model, prompt, stream: false,
        ...(options.schema || options.json ? {format: options.schema ?? "json", options: {temperature: 0, num_predict: 4096, num_ctx: 32768}} : {})})
    }, options.signal);
    if (!data || typeof data !== "object" || !("response" in data) || typeof data.response !== "string") throw new Error("Invalid local Ollama response. No cloud fallback.");
    return data.response;
  }
}
