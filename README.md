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

## Install and smoke-test locally (macOS / VS Code)

Prerequisites: Node.js 22, VS Code 1.90+, and Ollama running **on the same machine as the VS Code extension host**.

```bash
git clone https://github.com/mathias82/ai-privacy-router.git
cd ai-privacy-router
npm install
npm test
ollama pull qwen2.5-coder:7b
ollama serve  # only if Ollama is not already running
```

In another terminal:

```bash
npm run package:vsix
code --install-extension ai-privacy-router-0.0.1.vsix
```

Reload VS Code. Open a text file, select some text, open the Command Palette and run **AI Privacy Router: Ask Local Qwen About Selection**. Enter a short instruction and check that a Markdown answer opens. Also run **AI Privacy Router: Classify Selection** and **AI Privacy Router: Review Cloud Override (No Transfer)**.

For a negative test, stop Ollama and repeat the local command. It must show a local error, **not** fall back to a cloud model.

The Ollama endpoint is hard-coded to `127.0.0.1:11434`; in Remote SSH, containers, or WSL, this refers to the extension host, not necessarily your laptop. The default model can be changed in VS Code Settings under `aiPrivacyRouter.ollamaModel`.

**Important limitations:** Privacy detection is heuristic; no content is certified safe for cloud use. The override UI is a **review-only prototype**; it records local audit metadata but does not send anything to Sonnet. The VSIX is for private local testing, not Marketplace publication. Do not test with actual company secrets or production personal data until the extension has been independently reviewed.

## One-command local AI startup (macOS)

After installing Ollama with `brew install ollama`, run from this repository:

```bash
npm run ai:start
```

This starts the local Ollama server if needed, downloads `qwen2.5-coder:7b` only if missing, and opens an interactive Qwen session. Type `/bye` to exit the chat; the server remains available to the VS Code extension.

To start the server and ensure the model is installed **without** opening an interactive session:

```bash
npm run ai:serve
```

You can override the model using `OLLAMA_MODEL=other-model npm run ai:start`. Keep the VS Code `aiPrivacyRouter.ollamaModel` setting consistent. The script contacts only the local Ollama endpoint, except that `ollama pull` downloads a missing model. Do not start a second server if one is already running.

## Local Qwen in VS Code Chat

Run `npm run ai:serve`, select code in an editor, open VS Code Chat and enter `@privacy Find bugs in the selected Java code`. The `@privacy` participant uses local Ollama and reports structured review findings in the Chat panel. It is separate from Copilot/Auto and does not use cloud fallback. If selection is not available, select the code again. Note: the last non-empty selection may be reused when switching focus; verify the selection before sending a new question.

### Sticky Chat mode

Use `@ai-privacy` once to select the local assistant. It is marked sticky, so subsequent turns in the same Chat conversation stay with this participant unless you switch agents. Use `/review` while this participant is active for code review. The configured local model defaults to `qwen2.5-coder:7b` via `aiPrivacyRouter.ollamaModel` and persists in VS Code Settings. VS Code does not expose this local Ollama model as a Copilot model-picker entry; `/ai-privacy` is not a global Chat slash command. Use `@ai-privacy` for the participant and `/review` for its command.
