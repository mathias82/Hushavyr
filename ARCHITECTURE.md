# Architecture

Hushavyr runs as a VS Code extension, a terminal (`hushavyr`) and CI commands. All three share the same code in `src/`. Folders are grouped by responsibility. The tests in `src/test/` use the same folders.

## Entry points (top of `src/`)

| File | Runs as |
| --- | --- |
| `extension.ts` | VS Code extension (`main` in `package.json`) |
| `cli.ts` | `hushavyr-scan`: project scan with SARIF output, used in CI |
| `prReview.ts` | `hushavyr-review`: review of a pull request's changed lines |
| `benchmark.ts` | AI review and static benchmark (`npm run review:benchmark`, `npm run benchmark:static`) |
| `terminal/repl.ts` | `hushavyr`: the interactive terminal (`bin/hushavyr`) |

## Packages

| Folder | Responsibility |
| --- | --- |
| `review/` | Local AI review: prompts, the general, security and robustness passes, the second-pass verifier, finding validation, the "local model may be wrong" signals, review cache and extra context (callers, related Java, tests). |
| `scan/` | Reviews without AI: built-in security rules, taint and data flow, reachability, secrets, Semgrep and other installed analyzers, workspace scan, SARIF, dismissed findings (`.hushavyr/dismissed.json`). |
| `deps/` | Dependency CVEs: Trivy, OSV-Scanner, offline vulnerability databases and their daily update. |
| `fix/` | Changing code: `/fix`, `/edit`, diffs to approve, red/green proof in offline Docker, fix pull requests and regression tests. |
| `escalation/` | Optional cloud escalation: classification, routing, pseudonymization, approval preview, audit log and suggestions. Nothing is sent without approval. |
| `model/` | Ollama client, model choice by memory, setup and install steps. |
| `search/` | Code search by name (typos allowed), by meaning (local embeddings) or with the local model, and the project overview. |
| `parsing/` | Tree-sitter parsers (Java and other languages) and the Python-to-brace converter used by the taint engine. |
| `git/` | Changed files and pull request creation (`git`, `gh`). |
| `vscode/` | VS Code only: chat participant, commands, diagnostics, reports, translations. |
| `terminal/` | The `hushavyr` terminal: REPL, command parsing, setup, Copilot CLI adapter. |
| `util/` | Small shared helpers. |

## Rules

- The terminal and the CLI run with Node alone, so every module they import must not import `vscode`. VS Code commands for a feature can sit next to that feature (for example `deps/trivyCommands.ts`, `fix/applyFix.ts`), but the terminal never imports them.
- Files outside `src/` that the code needs (`rules/`, `dist/vendor/`, `package.json`) are found relative to `__dirname`. If you move a file, update those paths.
- Tests go in the matching folder under `src/test/`. `npm test` runs `dist/test/**/*.test.js`.
