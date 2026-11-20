# Qwen and Sonnet review comparison

Use the same 14 public Java, Python, TypeScript and JavaScript fixtures and the same first-pass review prompt for both models. Record the model version and run date. For single-pass comparison, send each prompt independently without tools, history, repairs or a second reviewer pass.

```sh
npm ci
npm run build
node dist/benchmark.js --prompts > prompts.json
node dist/benchmark.js --score qwen-responses.json
node dist/benchmark.js --score sonnet-responses.json
```

Each response file is a JSON object mapping every case ID from `prompts.json` to the model's exact response as a JSON string. The benchmark CLI exports only its built-in public fixtures. It does not submit a cloud request.

Compare precision, recall, false positives, invalid responses and rejected findings. A rejected finding can indicate invalid formatting, missing evidence or a fabricated source location. Read the raw replies locally to distinguish those failures. False positives use the known fixture expectations and need manual review if the model finds another real bug.

Run `npm run review:benchmark` separately to measure the full local Ollama review workflow with repair and verification. Patch quality requires actual regression runs and is outside this review-only comparison.
