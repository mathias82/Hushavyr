# Changelog

## 0.0.30
- `/scan` now runs every check: built-in rules, cross-file data flow and Trivy CVEs with function reachability, in addition to the AI review, Semgrep and Gitleaks.
- `.hushavyr/ignore`: gitignore-style paths that `/scan`, `/security` and the CLI never scan (for intentional test fixtures).
- Secrets scan no longer reports file globs such as `"**/*.{env,yml}"` as credentials.
- `/escalate` (opt-in, `aiPrivacyRouter.cloudEscalation`): sends only the selected function to a Copilot model. Names, strings and comments are pseudonymized and restored locally. It is blocked for secrets, personal data, sensitive or ignored files and local-only workspaces. You preview and approve the exact payload, and every send is audited.
- Simpler README.

## 0.0.29
- Function-level CVE reachability: `/dependencies` and the CLI show when the vulnerable function itself (from the advisory title or a curated list: lodash, jackson-databind, snakeyaml, PyYAML...) is called, with a link to the call. Those CVEs are listed first.
- Project-wide taint: `/security`, `/review` and the CLI follow request input (`req.query`, `@RequestParam`, Flask/FastAPI routes...) through functions and files to SQL, shell, eval, file, outbound-URL and innerHTML sinks. No model, no Semgrep Pro.
- `/explain` and `/review` ignore Chat instruction files (copilot-instructions.md, AGENTS.md, .ai-context) and use the open code file.
- PR review in CI: `hushavyr-review` reviews only the changed lines of a PR with local Ollama, applies team rules and dismissals, and writes a PR comment (Markdown) and SARIF. Example workflow for a self-hosted runner: `examples/hushavyr-pr-review.yml`.
- Team rules: write your standards in `.hushavyr/rules.md` (first 3 KB, trusted workspaces only); `/review` also reports concrete violations of them.
- Team memory: quick fix **Hushavyr: not a real issue (hide for the team)** stores a fingerprint and reason in `.hushavyr/dismissed.json`; commit it and the finding stays hidden for everyone, even after the line moves.
- Quick fix **Hushavyr: prove with a failing test (offline Docker)** on `/review` markers (Java, Python, JS, TS): runner, project, file and bug description are filled in; a failing approved test reports the bug as confirmed even when no fix is verified.
- `/semgrep` merged into `/security`: one project scan with the full bundled Semgrep rule pack, built-in rules and credentials, clickable locations and one finding per line.
- New `/explain`: explains the open, selected or attached code in prose. `/review` is for bugs and security issues only; asking it to explain still works but points to `/explain`.
- Hybrid `/review`: local model + bundled Semgrep rule pack (`rules/hushavyr-review.yml`: SQL/command/code injection, XSS, path traversal, SSRF, XXE, unsafe deserialization, disabled TLS, weak crypto) triaged together, then verified locally. Falls back to the built-in rules when Semgrep is not installed.
- Thorough review by default: general, security and robustness passes (`aiPrivacyRouter.reviewDepth`).
- Review answers start with a summary: issue count by severity and the one to fix first.
- Cross-file call context: definitions of called functions and callers (`aiPrivacyRouter.callContext`).
- `/dependencies`: CVEs tagged imported / not imported directly, imported first.
- Model kept loaded for 30 minutes; identical reviews are served from cache.
- **Hushavyr: Export Findings as SARIF** command and `hushavyr-scan` CLI with `--sarif` and `--fail-on` for CI.
- Benchmark grew to 35 fixtures; CI now gates the rule pack (no false positives, every in-scope security bug found).

## 0.0.28
- `/review explain the code` (or "what does this do", Greek "τι κάνει") now answers in prose instead of running the bug-finding review.
- Chat banner shows the real local model and explains the sensitivity label.
- Offline rules: hardcoded credentials in code declarations (`const password = "..."`, `private static final String API_KEY = "..."`) and SQL built by string concatenation in JS/TS/Python (`query("SELECT ... " + x)`).

## 0.0.27
- `/review-changes`: reviews your uncommitted git changes locally (up to 4 files, 20 KB budget), with inline markers.
- Quick fix "Hushavyr: propose a local fix" on `/review` markers: the local model rewrites the few marked lines, you see a diff and approve before anything changes.

## 0.0.26
- `/dependencies` warns when the local Trivy vulnerability database is more than 7 days old.
- Ollama context reduced to 16K tokens (still above the 20 KB review limit): less memory, steadier 14b.
- Greek (`aiPrivacyRouter.language: el`) for Setup messages too.

## 0.0.25
- Default model now follows your machine: unless `aiPrivacyRouter.ollamaModel` is set, Hushavyr uses `qwen2.5-coder:14b` (20 GB+ memory) or `32b` (48 GB+) instead of `7b`; first use downloads it automatically.

## 0.0.24
- Quick fix on dependency markers: "Update to <fixed version>" when the version is on the marked line (pom property, package.json, requirements).
- **Hushavyr: Update Trivy Vulnerability Database** (asks consent; the only network step).
- **Hushavyr: Export SBOM (CycloneDX)** writes `hushavyr-sbom.cdx.json` locally.
- `/dependencies` also recognises yarn, pnpm, Go, Cargo, Composer, Bundler and NuGet lockfiles.
- `aiPrivacyRouter.language` (`en`/`el`): Greek output for `/dependencies` and the new commands.
- `/review` now follows local imports for TypeScript/JavaScript and Python files (max 3 related files), like Java.

## 0.0.23
- **Hushavyr: Setup** command: checks Ollama, lets you pick a local model (recommends one for your memory), downloads it with progress, and offers Semgrep, Gitleaks and Trivy installs.
- Missing local models are downloaded automatically on first use (loopback Ollama only, no cloud fallback), with progress.
- `/review` suggests a larger local model when a small one proposes nothing.
- Fixed double-escaped `\n`/`\r` sequences that corrupted `/semgrep`, `/gitleaks`, `/dependencies` and `/scan` output and sanitizers.
- Install prompts for Gitleaks and Trivy (previously Semgrep only).
- `/review` findings now appear inline as editor Problems (`Hushavyr: Clear Review Markers` removes them).
- `/dependencies` now lists each CVE (severity, package, installed and fixed version) instead of only a count, grouped across manifests, with markers on the dependency line (or version property) in each manifest; `Clear Review Markers` clears them.
- First-launch Setup invitation, low-memory warning for oversized models, README quick start updated.
- `extension.ts` split: the workspace scan handler now lives in `workspaceScan.ts`.
- Offline rules now cover Go, C#, PHP, Ruby and Rust TLS checks, Python deserialization, dynamic `eval`, and more shell execution sinks.

## 0.0.22
- Auto-download of the configured model, generalized tool install prompts, escape fixes.
