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
npm ci
npm test
ollama pull qwen2.5-coder:7b
ollama serve  # only if Ollama is not already running
```

In another terminal:

```bash
npm run package:vsix
code --install-extension ai-privacy-router-0.0.3.vsix
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

Run `npm run ai:serve`, select code in an editor, open VS Code Chat and enter `@ai-privacy Find bugs in the selected Java code`. The `@ai-privacy` participant uses local Ollama and reports structured review findings in the Chat panel. It is separate from Copilot/Auto and does not use cloud fallback. If selection is not available, select the code again. Note: the last non-empty selection may be reused when switching focus; verify the selection before sending a new question.

### Sticky Chat mode

Use `@ai-privacy` once to select the local assistant. It is marked sticky, so subsequent turns in the same Chat conversation stay with this participant unless you switch agents. Use `/review` while this participant is active for code review. The configured local model defaults to `qwen2.5-coder:7b` via `aiPrivacyRouter.ollamaModel` and persists in VS Code Settings. VS Code does not expose this local Ollama model as a Copilot model-picker entry; `/ai-privacy` is not a global Chat slash command. Use `@ai-privacy` for the participant and `/review` for its command.

## Evidence-gated local code review

Use `@ai-privacy /review check code for bugs`. Attach up to **8 local files**, with **20 KB total** across instruction, paths and source. Alternatively select code or use the focused file. The extension never scans the workspace automatically. Unreadable context or exceeded budgets stop the request rather than silently dropping source.

The reviewer receives numbered source lines and returns file paths plus inclusive line ranges. The extension extracts the actual source text itself, avoiding JSON escaping errors when the Java code contains quotes or backslashes. Selections retain their original file line numbers. Paths and ranges must belong to supplied sources. Legacy exact-evidence responses still pass the original source-match checks.

If parsing fails or all findings are rejected, one bounded repair request receives the validator's reasons. A separate skeptical local pass then checks accepted findings against the supplied files. It may reject unsupported claims. If the second pass fails, results are explicitly unverified. The same model serves both passes by default; `aiPrivacyRouter.verifierModel` can select a different installed local model. Two prompts to the same model are not independent runtime proof. Maximum: review + repair + verifier, all loopback.

Every finding remains **potential**. Neither model agreement nor a successful existing suite proves an individual bug or fix. No generated tests or patches are applied automatically. Source matching and the SQL/getter filters are heuristics, not formal verification or complete DLP.

## Existing regression tests

Use `@ai-privacy /test` or **AI Privacy Router: Run Existing Regression Tests**. Choose a trusted workspace folder and a fixed runner: `npm test`, `mvn test`, `./mvnw test`, `gradle test`, `./gradlew test`, or `python -m pytest`.

The runner executes that project's existing scripts, with no model-supplied command, arguments or generated code. It records actual exit status, duration, timeout and cancellation. Output is not stored or sent to a model. The default timeout is two minutes. On macOS/Linux cancellation kills the runner process group; Windows only stops the immediate process and may require manual cleanup of descendants. The intended local environment is macOS/Linux.

## Local model configuration

Settings are application-scoped, so repository settings cannot relax the user's policy or redirect the provider.

| Setting | Default | Behavior |
| --- | --- | --- |
| `aiPrivacyRouter.ollamaModel` | `qwen2.5-coder:7b` | Must already be installed locally |
| `aiPrivacyRouter.ollamaEndpoint` | `http://127.0.0.1:11434` | Loopback HTTP origin only; redirects rejected; localhost canonicalized to 127.0.0.1 |
| `aiPrivacyRouter.timeoutSeconds` | 180 | Per model request |
| `aiPrivacyRouter.verifierModel` | empty | Reuses reviewer unless another local model is selected |
| `aiPrivacyRouter.mandatoryLocalOnly` | false | When true, denies even review-only cloud approvals |
| `aiPrivacyRouter.requireReviewer` | false | Denies approvals without a verified reviewer callback |

Chat checks Ollama's local model inventory before generation. Review requests reserve a 32,768-token context window and cap output at 4,096 tokens. The conservative source and prompt byte budgets reduce accidental context truncation; model compatibility and quality still need local measurement. The startup script manages the default endpoint; custom loopback servers must be started separately.

## Full-context privacy and review-only overrides

Classification covers prompts, selected code, attachments, tool outputs and retrieved context. Missing content, restricted labels/paths, detected credentials and PII deny overrides even if labeled public. Nothing becomes proven public just because a pattern did not match. The current extension has no tools or retrieval provider that silently adds additional context.

**Review Cloud Override (No Transfer)** opens the entire candidate context in a local preview, names the hypothetical destination, requests a reason and explicit confirmation, and rechecks policy. Cancellation defaults to denial. Required reviewer approval cannot be granted in the UI because no reviewer identity provider is connected. The reusable workflow supports a verified reviewer callback for a future integration; self-confirmation is not treated as reviewer identity.

Cloud dispatch remains disabled. A transport-independent guarded transfer boundary is tested with fake transports only, ready for a separately authorized future adapter. It scans an immutable snapshot and awaits separate approval and attempted-dispatch audit events before invoking any transport. Failure, cancellation and completed dispatch are separate outcomes. A post-send audit error propagates without retrying a send.

Audit logs contain only allowlisted metadata, IDs, reason codes, approval type, outcome and optional token counts. Unexpected runtime fields, invalid event pairs and free-form reasons are rejected. Files use append mode, reject symlinks and restrict permissions to 0600 on POSIX. New logs live in the extension's private `audit` directory as daily segments, with 30-day retention. Existing legacy `cloud-review.jsonl` files are not automatically removed. Access control depends on the local OS account; this is not a tamper-proof remote audit service.

## Local quality benchmark

```bash
npm run review:benchmark
```

This runs the real configured local model through review, possible repair and verification on eight synthetic examples: JSON escaping, null checks, integer overflow and cross-file null handling, with positive and clean pairs. Use `OLLAMA_MODEL`, `OLLAMA_VERIFIER_MODEL` and `OLLAMA_ENDPOINT` to select installed local models and a loopback endpoint. No model is downloaded by the benchmark.

The JSON summary reports fixture-level precision, recall, unexpected findings, failures, verifier failures and durations. Matching requires the expected source location and failure mechanism; duplicate findings count as extra findings. It exits nonzero for missed bugs, unexpected findings, review errors or verifier failures. It prints neither source nor raw model responses. This small calibration set is not a production evaluation or proof of Sonnet/Sol 6.1 parity. No cloud comparator is connected.

## Validation and smoke test

```bash
npm ci --ignore-scripts
npm run build
npm test
npm run package:vsix
code --install-extension ai-privacy-router-0.0.3.vsix
```

Reload VS Code, start local Ollama and repeat `/review` on the JSON-concatenating mapper. Evidence should come from actual source lines, with second-pass status. Attach its exception class too to exercise multi-file review. Run `/test` on a disposable project. Cancel a local request and verify it stops. Stop Ollama and verify there is no fallback. Try override cancellation and a synthetic PII sample: no cloud transfer should occur.

CI uses `npm ci`, build and security regression tests. Automated tests use fake model/VS Code APIs plus actual disposable project test processes. Live detection quality, VS Code rendering and a real local model run require the smoke test on the user's machine.
