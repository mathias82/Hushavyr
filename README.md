# Hushavyr — Private AI Code Review

**Privacy-first code review for VS Code, powered by local Ollama.** Review code, run tests, and inspect supported projects without sending source code to a cloud model.

## Chat commands

Type `@ai-privacy` in VS Code Chat:

| Command | Purpose |
| --- | --- |
| `/review` | Review the open or attached code locally |
| `/test` | Run supported local project tests |
| `/auto` | Privacy-aware routing of typed prompts |
| `/scan` | Local project review (up to 5,000 files, batches of 50) |
| `/scan-changed` | Review changed files using local SHA-256 indexing |
| `/secrets` | Offline heuristic scan for hardcoded credentials (values redacted) |
| `/security` | Offline source security indicators and credentials scan |
| `/semgrep` | Run bundled offline Semgrep rules using locally installed Semgrep |
| `/gitleaks` | Run locally installed Gitleaks to detect exposed secrets (values redacted) |
| `/dependencies` | Audit dependencies offline with locally installed Trivy and preloaded vulnerability database |

Available commands depend on the extension installed in VS Code. Semgrep and Gitleaks require their respective local executables; Hushavyr does not automatically install them.

## Preview

See the [Hushavyr interface preview](docs/images/hushavyr-local-review.svg) on GitHub.

*Illustrative interface with synthetic text; no company source code.*

## Quick start

1. [Install Hushavyr from VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=mathias82.hushavyr).
2. In the Command Palette, run **Hushavyr: Install Ollama**, **Start Ollama**, and **Download Local Qwen Model** (`qwen2.5-coder:7b`).
3. Open a trusted local project and try `@ai-privacy /review` or `@ai-privacy /scan`.
4. Install Semgrep and/or Gitleaks locally and run `@ai-privacy /semgrep` or `@ai-privacy /gitleaks`. The extension does not automatically download scanner binaries or rules.

**Privacy boundary:** Local review and scanning use Ollama without cloud fallback. Hushavyr cannot intercept requests made directly to Copilot, Claude, or other VS Code assistants. Findings are potential issues requiring independent verification.

For setup, supported languages, security limits, and troubleshooting, see the [full user guide](docs/guide.md).

**Author:** Matthaios Stavrou · [GitHub](https://github.com/mathias82/Hushavyr)

**Offline dependency audit:** Install Trivy and preload its vulnerability database while outside restricted networks. Hushavyr runs Trivy with offline scanning and DB updates disabled. An absent or outdated database must not be interpreted as a clean scan. This initial integration reports counts, not verified fixed-version recommendations.
