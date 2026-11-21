# Multi-provider benchmark (opt-in, synthetic only)

The **model selector** is `--provider ollama|copilot|openai --model MODEL` for benchmark runs. This does **not** change the Hushavyr extension's production review model or its local-only privacy policy. Cloud is never an automatic fallback.

```sh
npm ci && npm run build
node benchmarks/providers.mjs export --out benchmarks/copilot-prompts.json
node benchmarks/execute-providers.mjs --provider ollama --model qwen2.5-coder:7b --out /tmp/ollama-results.json
node benchmarks/execute-providers.mjs --provider copilot --model YOUR_AVAILABLE_MODEL --approve-synthetic-cloud --out /tmp/copilot-results.json
OPENAI_API_KEY=... node benchmarks/execute-providers.mjs --provider openai --model YOUR_API_MODEL --approve-synthetic-cloud --out /tmp/openai-results.json
node benchmarks/combine-providers.mjs --out /tmp/combined.json /tmp/ollama-results.json /tmp/copilot-results.json /tmp/openai-results.json
node benchmarks/providers.mjs score --responses /tmp/combined.json --out /tmp/scored.json
```

Copilot requires an authenticated, installed **Copilot CLI** supporting `-p`, `--model`, `--silent`, `--no-ask-user`. Copilot Pro subscription alone does not guarantee CLI model access. Check `copilot --help` and `copilot auth status` first. OpenAI API requires separate API billing. Neither API credentials nor source are written into reports. Use only synthetic fixtures and inspect the exported prompts before consenting to cloud transfer.

**Limitations:** model responses may not be valid review JSON, failed runs are explicitly recorded, the existing scorer validates finding structure, and timing is per fixture. Costs and token usage are not available consistently and must not be invented. This is a benchmark-only provider selector, not an extension UI selector. To add a production UI selector, first implement separate consent and policy tests; never allow cloud for sensitive workspace code. The static 112-case scanner benchmark is a different dataset from this AI benchmark.
