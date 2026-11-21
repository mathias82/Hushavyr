# Copilot Pro / OpenAI / Ollama comparison (offline exchange)

This benchmark uses the existing `dist/benchmark.js` fixture set and its existing scoring logic. It does **not** imply that a GitHub Copilot Pro subscription grants API access, or that a cloud review was executed.

1. `npm ci && npm run build`
2. `node benchmarks/providers.mjs export --out benchmarks/copilot-prompts.json`
3. Review the synthetic prompts before sharing. Run each prompt with your authorized Copilot interface, OpenAI API/client, or Ollama, and save the raw responses in a local JSON file:

```json
{
  "providers": {
    "copilot-pro-selected-model": {
      "json-escaping-bug": "the exact model response",
      "json-serializer-clean": "the exact model response"
    },
    "ollama-qwen-local": {
      "json-escaping-bug": "the exact model response",
      "json-serializer-clean": "the exact model response"
    }
  }
}
```

Include **every fixture ID** for a valid complete comparison. Never fabricate missing model responses. Record the actual model ID, run date, latency and token usage separately where available. Model identity is self-reported, not independently verified by this offline tool.

4. `node benchmarks/providers.mjs score --responses private-provider-responses.json --out benchmarks/provider-comparison.json`

The scoring adapter invokes the existing benchmark `--compare` implementation. The workflow does not contact external services or send proprietary code. **Automatic invocation of Copilot or OpenAI is not implemented**: a supported provider interface, explicit permission, rate-limit handling, and credential management are prerequisites. Do not commit response files containing private content.

The 112-case static scanner suite in PR #104 is a **different benchmark** from the AI review fixture suite in `src/benchmark.ts`. Do not compare their precision/recall as though they used the same test cases.
