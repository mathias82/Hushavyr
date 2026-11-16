export interface LocalModelConfig { model: string; timeoutMs?: number }
export interface OllamaTransport { (url: string, init: RequestInit): Promise<Response> }
const BASE = "http://127.0.0.1:11434";
export class LocalOllama {
  constructor(private readonly config: LocalModelConfig, private readonly transport: OllamaTransport = fetch) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(config.model)) throw new Error("Invalid local model name");
  }
  async generate(prompt: string, options: {json?: boolean} = {}): Promise<string> {
    if (!prompt.trim()) throw new Error("Empty prompt");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 120000);
    try {
      const response = await this.transport(BASE + "/api/generate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.config.model, prompt, stream: false, ...(options.json ? {format: "json", options: {temperature: 0}} : {}) }),
        signal: controller.signal
      });
      if (!response.ok) throw new Error("Local Ollama request failed (HTTP " + response.status + ")");
      const data: unknown = await response.json();
      if (!data || typeof data !== "object" || !("response" in data) || typeof data.response !== "string")
        throw new Error("Invalid local Ollama response");
      return data.response;
    } catch {
      throw new Error("Local Ollama unavailable or request failed. No cloud fallback.");
    } finally { clearTimeout(timeout); }
  }
}
