# Changelog

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
