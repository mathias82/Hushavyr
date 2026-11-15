# AI Privacy Router

Private prototype of a privacy-first AI router for VS Code.

## Principles
- Classify the entire outbound payload, not only the prompt.
- Local-only for sensitive or uncertain content.
- Never silently fall back to cloud.
- Cloud routing is disabled by default.
- Human overrides cannot bypass mandatory policy.
- No document contents or secrets in logs.

## MVP
TypeScript classifier, local Ollama adapter, VS Code command and tests. Cloud adapters will be added only after explicit opt-in and security review.
