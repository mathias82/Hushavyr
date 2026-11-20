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
    if (/(?:^|[:/-])cloud(?:$|[:/-])/i.test(config.model)) throw new Error("Cloud models are not allowed on the local route");
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
    const installed = data.models.find(m => m && typeof m === "object" && (m.name === this.config.model || m.name === expected));
    if (installed && (("remote_model" in installed && installed.remote_model !== "") || ("remote_host" in installed && installed.remote_host !== ""))) throw new Error("Remote Ollama model rejected. No prompt sent.");
    if (!installed) {
      throw new Error("Configured model is not installed locally. Run npm run ai:serve or install it with Ollama. No cloud fallback.");
    }
  }
  /** Downloads the configured model from the local Ollama server when it is not installed yet. */
  async ensureInstalled(signal?: AbortSignal, onPull?: () => void): Promise<void> {
    try {
      await this.ensureAvailable(signal);
      return;
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("Configured model is not installed")) throw error;
    }
    onPull?.();
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    if (signal?.aborted) abort();
    signal?.addEventListener("abort", abort, {once: true});
    const timeout = setTimeout(abort, 60 * 60 * 1000);
    try {
      const response = await this.transport(this.base + "/api/pull", {
        method: "POST", headers: {"Content-Type": "application/json"}, redirect: "error", signal: controller.signal,
        body: JSON.stringify({model: this.config.model, stream: false})
      });
      const data: unknown = response.ok ? await response.json() : undefined;
      if (!data || typeof data !== "object" || !("status" in data) || data.status !== "success") throw new Error("pull failed");
    } catch {
      throw new Error("Could not download the local model. No cloud fallback.");
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
    await this.ensureAvailable(signal);
  }
  async assertLocalModel(signal?: AbortSignal): Promise<void> {
    // Model aliases can reference remote inference despite a loopback server URL.
    const metadata = await this.request("/api/show", {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({model: this.config.model})
    }, signal);
    if (!metadata || typeof metadata !== "object" ||
      ("remote_model" in metadata && metadata.remote_model !== "") || ("remote_host" in metadata && metadata.remote_host !== "") ||
      !("model_info" in metadata) || !metadata.model_info || typeof metadata.model_info !== "object" ||
      Array.isArray(metadata.model_info) || !Object.keys(metadata.model_info).length) {
      throw new Error("Local model metadata is missing or remote. No prompt sent.");
    }
  }
  async generate(prompt: string, options: GenerateOptions = {}): Promise<string> {
    if (!prompt.trim()) throw new Error("Empty prompt");
    if (options.schema && Buffer.byteLength(prompt, "utf8") > 28000) throw new Error("Structured review prompt exceeds the local context budget");
    if (options.signal?.aborted) throw new Error("Local request cancelled");
    await this.assertLocalModel(options.signal);
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
