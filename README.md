# Hushavyr — Private AI Code Review

**Privacy-first code review for VS Code, powered by local Ollama.** Review code, run tests, and inspect supported projects without sending source code to a cloud model.

## Chat commands

Type `@ai-privacy` in VS Code Chat:

| Command | Purpose |
| --- | --- |
| `/review` | Find bugs and security issues in the open or attached code locally |
| `/explain` | Explain the open, selected or attached code locally |
| `/review-changes` | Review your uncommitted git changes locally |
| `/test` | Run supported local project tests |
| `/auto` | Privacy-aware routing of typed prompts |
| `/scan` | Local project review (up to 5,000 files, batches of 50) |
| `/scan-changed` | Review changed files using local SHA-256 indexing |
| `/secrets` | Offline heuristic scan for hardcoded credentials (values redacted) |
| `/security` | Offline source security indicators and credentials scan |
| `/semgrep` | Run bundled offline Semgrep rules using locally installed Semgrep |
| `/gitleaks` | Run locally installed Gitleaks to detect exposed secrets (values redacted) |
| `/dependencies` | Audit dependencies offline with locally installed Trivy and preloaded vulnerability database |

Available commands depend on the extension installed in VS Code. Semgrep, Gitleaks and Trivy require their local executables; Hushavyr offers to install them (with your consent) but never downloads anything silently.

## Command Palette

| Command | Purpose |
| --- | --- |
| **Hushavyr: Setup** | Check Ollama, choose and download a local model, install optional scanners |
| **Hushavyr: Update Trivy Vulnerability Database** | Download the public CVE database (asks first; no code leaves your machine) |
| **Hushavyr: Export SBOM (CycloneDX)** | Write `hushavyr-sbom.cdx.json` locally |
| **Hushavyr: Export Findings as SARIF** | Write current Hushavyr markers to `hushavyr.sarif` (GitHub code scanning, Azure DevOps, SARIF viewers) |
| **Hushavyr: Clear Review Markers** | Remove `/review` and dependency markers from the editor |

## Highlights

- **Hybrid review:** `/review` runs the local model (a general pass plus focused security and robustness passes) and the bundled Semgrep rule pack in parallel, then a second local pass verifies every finding. The answer starts with a summary: how many issues, how serious, which one to fix first. Use `aiPrivacyRouter.reviewDepth: fast` for a single pass, `aiPrivacyRouter.staticAnalysis: false` to skip Semgrep.
- **Cross-file context:** `/review` also sends the definitions of functions the file calls and the places that call it (same language, up to 3 snippets, within the 20 KB limit). Turn off with `aiPrivacyRouter.callContext: false`.
- **CVE priority:** `/dependencies` marks each vulnerable package as *imported* by your code or *not imported directly* (transitive or unused) and lists imported ones first. This is import-level only, not proof that the vulnerable function is called.
- **Faster repeats:** the model stays loaded for 30 minutes and an unchanged file is answered from cache.
- **CI and SARIF:** from a clone of this repository, `npm run build && node dist/cli.js [folder] --sarif hushavyr.sarif --fail-on high` scans a folder offline (bundled rules, Semgrep, credentials, Trivy) for pipelines; see `.github/workflows/hushavyr-scan.yml` for upload to GitHub code scanning.
- **Smart default model:** unless you set `aiPrivacyRouter.ollamaModel`, Hushavyr uses `qwen2.5-coder:14b` on 20 GB+ memory and `32b` on 48 GB+ (otherwise `7b`), downloaded automatically on first use.
- **Local fixes:** on a `/review` marker choose the quick fix *Hushavyr: propose a local fix*; the local model proposes a diff and nothing changes until you approve.
- **Findings in the editor:** `/review` results appear as Problems; `/dependencies` lists each CVE once with severity, fixed version and affected manifests, and marks the dependency line. A quick fix updates the version when it is on that line.
- **Dependency ecosystems:** Maven, Gradle, npm, yarn, pnpm, pip, Poetry, Pipenv, Go, Cargo, Composer, Bundler, NuGet.
- **Richer review context:** `/review` follows local imports in Java, TypeScript/JavaScript and Python (up to 3 related files).
- **Language:** set `aiPrivacyRouter.language` to `el` for Greek `/dependencies` and Setup messages.

## Preview

See the [Hushavyr interface preview](docs/images/hushavyr-local-review.svg) on GitHub.

*Illustrative interface with synthetic text; no company source code.*

## Quick start

1. [Install Hushavyr from VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=mathias82.hushavyr).
2. Run **Hushavyr: Setup** from the Command Palette (also offered on first launch). It checks Ollama, lets you pick a local model (it recommends one for your memory: `qwen2.5-coder:7b`, `14b` or `32b`; without a setting, that recommendation is used automatically), downloads it with progress, and offers one-click installs for Semgrep, Gitleaks and Trivy. Every install needs your explicit approval. If Ollama itself is missing, use **Hushavyr: Install Ollama**.
3. Open a trusted local project and try `@ai-privacy /review` or `@ai-privacy /scan`. A missing model is downloaded automatically on first use.
4. Run `@ai-privacy /semgrep`, `/gitleaks` or `/dependencies`. If a scanner is missing, Hushavyr offers to install it; nothing is downloaded silently.
5. Small models (7B) often miss bugs. The default already uses `qwen2.5-coder:14b` or larger when your machine has 20 GB+ of memory.

**Privacy boundary:** Local review and scanning use Ollama without cloud fallback. Hushavyr cannot intercept requests made directly to Copilot, Claude, or other VS Code assistants. Findings are potential issues requiring independent verification.

For setup, supported languages, security limits, and troubleshooting, see the [full user guide](docs/guide.md).

**Author:** Matthaios Stavrou · [GitHub](https://github.com/mathias82/Hushavyr)

**Offline dependency audit:** Install Trivy and preload its vulnerability database while outside restricted networks. Hushavyr runs Trivy with offline scanning and DB updates disabled. An absent or outdated database must not be interpreted as a clean scan. `/dependencies` lists each CVE with package, installed version, fixed version (when Trivy knows one) and severity; the fixed version comes from the Trivy database and is not verified against your build.
