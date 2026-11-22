# Hushavyr — Private AI Code Review & Security Scanner for VS Code

[![VS Marketplace](https://vsmarketplacebadges.dev/version-short/mathias82.hushavyr.svg)](https://marketplace.visualstudio.com/items?itemName=mathias82.hushavyr)
[![Open VSX](https://img.shields.io/open-vsx/v/mathias82/hushavyr?label=Open%20VSX)](https://open-vsx.org/extension/mathias82/hushavyr)
[![Installs](https://vsmarketplacebadges.dev/installs-short/mathias82.hushavyr.svg)](https://marketplace.visualstudio.com/items?itemName=mathias82.hushavyr)
[![Rating](https://vsmarketplacebadges.dev/rating-star/mathias82.hushavyr.svg)](https://marketplace.visualstudio.com/items?itemName=mathias82.hushavyr&ssr=false#review-details)
[![CI](https://github.com/mathias82/Hushavyr/actions/workflows/ci.yml/badge.svg)](https://github.com/mathias82/Hushavyr/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Hushavyr is a **free, offline AI code reviewer** and **security scanner (SAST)** for VS Code, Cursor, VSCodium, Windsurf and the terminal. It runs **on your machine** with Ollama, so it is a private alternative to cloud AI code review. It finds bugs, security vulnerabilities (OWASP Top 10, SQL injection, XSS, command injection, path traversal), hardcoded secrets and vulnerable dependencies (CVEs), then explains each finding in the context of your code and **fixes it with local AI**: you see a diff and nothing changes until you approve it. It can prove a fix with a failing test and open the pull request. Your code never goes to a cloud model. The same private AI assistant also runs in **any terminal**: type `hushavyr` to chat about your code, scan it and fix findings, like a local, offline Copilot CLI.

**Accuracy:** 97.2% on the [OWASP Benchmark for Java](docs/owasp-benchmark.md) and 100% on the [OWASP Benchmark for Python](docs/owasp-benchmark-python.md), both with 0% false positives. On [six real vulnerable apps](docs/real-world-benchmarks.md) (Juice Shop, WebGoat, DVWA, RailsGoat, GoVWA, WebGoat.NET) it finds SQL, NoSQL, command, path, XSS, XXE and deserialization flaws in TypeScript, Java, PHP, Ruby, Go and C#; on Juice Shop 37 of 38 HIGH findings are real.

**Works with:** Java, Kotlin, Python, JavaScript, TypeScript, Go, Rust, C#, PHP and Ruby.

![Hushavyr demo: install, setup and every chat command running locally](https://raw.githubusercontent.com/mathias82/Hushavyr/main/docs/media/hushavyr-demo.gif)

▶️ [Watch in HD (MP4)](https://github.com/mathias82/Hushavyr/releases/download/v1.0.1/hushavyr-demo.mp4) · 📰 [Read the announcement on LinkedIn](https://www.linkedin.com/pulse/hushavyr-free-private-ai-code-review-security-scanner-stavrou-htyzf/)

## Why Hushavyr?

**Hushavyr** is a coined name built around **“hush”** the idea of keeping something quiet, confidential, and protected. **“-avyr”** is a distinctive invented ending, not a word with an established dictionary meaning.

The name expresses the project's privacy-first philosophy: review and improve code locally, keep sensitive information under your control, and require explicit approval before sharing anything externally.

> **Private AI. Verified Code.**  
> *Your code stays yours.*

This is a brand interpretation, not a literal translation of an existing word.

## Install

1. Install **Hushavyr** from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=mathias82.hushavyr), or from [Open VSX](https://open-vsx.org/extension/mathias82/hushavyr) for VSCodium, Cursor, Windsurf and Gitpod.
2. Run **Hushavyr: Setup** from the Command Palette. You pick the model and the analyzers, confirm once, and it does the rest: installs and starts Ollama, downloads the model, and installs Semgrep, Gitleaks, Trivy, OSV-Scanner, FindSecBugs, Bandit and gosec with the Trivy and OSV offline databases. Every command is listed before anything runs; run it again after a reboot to restart Ollama (finished steps are skipped).
   - **macOS:** everything via Homebrew.
   - **Linux:** Ollama via the official script. Analyzers via Homebrew if you have it, otherwise pipx (Semgrep, Bandit) or go (Gitleaks, gosec, OSV-Scanner); anything it cannot install is listed with an install link instead of failing.
   - **Windows:** Ollama via WinGet and the model; install the analyzers by hand if you want them.
3. Open a project and type `@ai-privacy /review` in Chat, or run **Hushavyr: Review Current File** from the Command Palette.

## Local AI CLI for the terminal (`hushavyr`)

Hushavyr includes a **local AI coding assistant for the terminal**, a private, offline alternative to cloud AI CLIs. Open the VS Code terminal in any project and type:

```sh
hushavyr
```

![Hushavyr terminal demo: hushavyr runs a security scan, fixes a SQL injection with local AI behind a diff you approve, and answers a question about a hardcoded password](https://raw.githubusercontent.com/mathias82/Hushavyr/main/docs/media/hushavyr-terminal.gif)

▶️ [Watch the terminal demo in HD (MP4)](https://github.com/mathias82/Hushavyr/releases/download/v1.0.6/hushavyr-terminal.mp4)

Ask anything in plain language. If you mention a file (`why does books.js leak memory?`), it is included. Ask about the project (`describe the project`) and Hushavyr reads its README, build files, folders and main types. Name a class or method (`why does OrderService.place send two mails?`) or describe the code (`where do we compute the loyalty discount?`) and Hushavyr finds it in the folder you started it in. It reads only that folder and its subfolders, never a parent folder.

All commands:

| Command | What it does |
| --- | --- |
| `/security [folder]` | Fast security scan with no AI: SQL injection, XSS, command injection, path traversal, data flow and secrets |
| `/secrets [folder]` | Hardcoded passwords, API keys and tokens (values are hidden) |
| `/dependencies [folder]` | CVEs in your libraries with Trivy and OSV-Scanner |
| `/scan [folder]` | Full project scan: built-in rules, data flow, secrets, Semgrep, Gitleaks, Trivy if installed |
| `/gitleaks [history] [folder]` | Secrets with Gitleaks; `history` checks every past commit, so a deleted password is still found |
| `/find <name or description>` | Find a class or method: by name, with typos allowed (`/find order servce`), or by description (`/find where the discount is computed`) |
| `/review <file\|name\|folder>` | Local AI review of a file, class or method for bugs and security issues, together with the static rules; a folder runs `/scan` |
| `/findings` | Show the last report again |
| `/explain <N\|file\|name\|description>` | Explain finding N, a file, a class or method, or the code you describe |
| `/fix <N>` | Fix finding N with local AI: shows a colored diff and writes the file only if you answer `y`. For a dependency CVE it upgrades the package in the manifest (`package.json`, `pom.xml`, `go.mod`, …) |
| `/dismiss <N> [reason]` | Hide finding N as not a real issue; saved in `.hushavyr/dismissed.json` and hidden for the whole team, in VS Code too |
| `/edit <file\|name> <request>` | Change a file, or only one method (`/edit OrderService.place add input checks`), behind the same diff and approval |
| `/undo` | Restore the file changed by the last `/fix` or `/edit` |
| `/prove <N\|file bug>` | Red/green proof in an offline Docker container: a regression test that fails, then a fix that makes it pass. You approve both, and the verified patch reaches your files only on `y` |
| `/pr [title]` | Commit, push a branch and open a pull request with `gh`, after you confirm. Stops if a changed file looks like it has a secret |
| `/escalate on\|off` | Allow or block sending code to GitHub Copilot. Off by default |
| `/escalate suggest on\|off` | Offer `/escalate` when the local model may be wrong (on by default; asks first, default No) |
| `/escalate <file>[:from-to] [question]` | Shows the exact pseudonymized text (names and strings replaced) and sends it through the [Copilot CLI](https://github.com/github/copilot-cli) only if you approve. Every send is logged in `~/.hushavyr/audit` |
| `/model [name]` | List installed models, or switch to another one |
| `/setup` | Install and start Ollama, download the model and install the analyzers (asks first) |
| `/update-db [auto on\|off]` | Download the latest public CVE databases (Trivy, OSV); `auto on` updates them daily before scans |
| `/clear` | Forget the conversation so far |
| `/help` | List the commands |
| `/exit` | Quit (also `exit`, `quit` or Ctrl+D) |

Tab completes commands, and Ctrl+C cancels a running request. `hushavyr /security` runs one command and exits; `hushavyr --model qwen2.5-coder:14b` starts with a specific model.

**In VS Code terminals it works right after you install the extension**, with no Node.js needed (it uses the editor's own runtime). For other terminals (Terminal.app, iTerm, Windows Terminal), **Hushavyr: Setup** offers to install it (checked by default), or run **Hushavyr: Install 'hushavyr' Command in Terminal PATH** once from the Command Palette. It writes a small launcher to `~/.local/bin` (macOS, Linux) or your user `WindowsApps` folder (Windows), offers to add the folder to your shell profile if needed, and keeps pointing at the current extension version after updates. The terminal uses the same local Ollama as the extension; the model you pick with `/model` is saved in `~/.hushavyr/config.json`. Your code never leaves your machine.

## What it uses

All of these run on your machine. Setup installs the optional tools only if you agree.

| Tool | What it does in Hushavyr | Needed for |
| --- | --- | --- |
| [Ollama](https://ollama.com) + Qwen coder models | Local AI review, explanations, edits and fixes | `/review`, `/explain`, `/edit`, `/improve`, `/scan` |
| Built-in rules and data-flow tracking | Security rules for Java, Python, JS/TS, Go, Rust, C#, PHP and Ruby. Data-flow tracking follows request input (`req.query`, `$_GET`, `params[...]`, `r.FormValue`, `Request.Form`) to SQL, NoSQL, shell, eval, file, URL and HTML calls in every one of these languages. No model needed | `/security`, `/scan`, CLI |
| Built-in secrets scanner | Hardcoded passwords, keys and tokens (values are hidden) | `/secrets`, `/scan`, `/pr` |
| [Semgrep](https://semgrep.dev) (optional) | Extra rules from the bundled Hushavyr rule pack | `/security`, `/scan`, CLI |
| [Gitleaks](https://github.com/gitleaks/gitleaks) (optional) | Secret detection in the files or the whole git history; also blocks credentials before `/pr` | `/gitleaks`, `/scan`, `/pr` |
| [Trivy](https://trivy.dev) (optional) | CVEs in dependencies, plus checks whether your code calls the vulnerable function; SBOM export | `/dependencies`, `/scan` |
| [OSV-Scanner](https://google.github.io/osv-scanner/) (optional) | More dependency CVEs from a downloaded OSV.dev database; runs with `--offline`. A CVE Trivy already reports is shown once | `/dependencies`, `/scan`, CLI |
| [FindSecBugs](https://find-sec-bugs.github.io) on [SpotBugs](https://spotbugs.github.io) (optional) | Security bugs in compiled Java/Kotlin classes (`target/classes`, `build/classes/*/main`), mapped back to the source line | `/security`, `/scan`, CLI |
| [Bandit](https://bandit.readthedocs.io) (optional) | Python security checks; only medium/high severity and confidence, no `assert` or test findings | `/security`, `/scan`, CLI |
| [gosec](https://github.com/securego/gosec) (optional) | Go security checks for Go modules; no unchecked-error (G104) or test findings | `/security`, `/scan`, CLI |
| [Docker](https://www.docker.com) (optional) | Offline sandbox with no network that proves a fix: the test fails before the fix and passes after. Supports Java/Maven, Python/pytest, JS/TS and Go | **Prove with a failing test**, verified fix → PR |
| [GitHub CLI](https://cli.github.com) `gh` (optional) | Opens the pull request | `/pr`, `/improve` |
| VS Code Chat + Copilot (opt-in only) | Gets only the pseudonymized selection, and only after you approve | `/escalate`, `/auto` |

Output is SARIF 2.1.0, so GitHub code scanning and any other SARIF viewer can read it.

## Models and memory

Setup picks the model for your machine and also lists the models you already have in Ollama. Choose **Other…** to use any local Ollama model (for example `codestral`), or change `aiPrivacyRouter.ollamaModel` later. The list never comes from the internet. `aiPrivacyRouter.reviewDepth` (default `auto`) picks how many review passes run for the same memory sizes.

| Memory | Default model | Notes |
| --- | --- | --- |
| under 12 GB | `qwen2.5-coder:3b` | Light mode: one short pass with an 8k context; the built-in rules and the verifier do most of the work. Runs on 8 GB laptops. |
| 12–20 GB | `qwen2.5-coder:7b` | Fast; one pass. |
| 20–30 GB | `qwen2.5-coder:14b` | Thorough: general, security and robustness passes. |
| 30 GB or more | `qwen3-coder:30b` | Best reviews. A mixture-of-experts model (about 3B active parameters), so it is faster than the 14b. |

**How a review is checked:** each finding must point at real lines of your code, and the file's own test (`FooTest.java`, `foo.test.ts`, `test_foo.py`…) and the callers of its functions are added as context. A second local pass then checks every finding and drops the ones it finds unsupported. A dropped finding gets one more narrow check of the lines around it; if the two checks disagree, the finding is not counted, but the review names it as a possible issue and may suggest `/escalate` for that line.

**Finding code:** names are matched first (typos and swapped letters are fine). If no name matches, the local model searches the code for you. Optionally, Hushavyr also searches by meaning with the small local model `nomic-embed-text` (about 270 MB). The terminal asks once whether to download it; in VS Code, run `ollama pull nomic-embed-text`. Its index is kept in `~/.hushavyr/index` (VS Code: the extension's storage), never in your repository, and is updated only for changed files.

**Hushavyr: Start Ollama** turns on flash attention and an 8-bit KV cache, which roughly halves context memory. The deterministic commands (`/security`, `/secrets`, `/dependencies`) need no model at all, `/review` results are cached, and `/scan-changed` skips files that did not change.

## VS Code Chat commands

Type `@ai-privacy` in VS Code Chat, then one of these commands:

| Command | What it does |
| --- | --- |
| `/review` | Finds bugs and security issues in the open file, or in a class or method you name, and checks your team rules |
| `/explain` | Explains the open or selected code, a class or method you name, or the code you describe |
| `/find` | Finds a class or method in the workspace by name (typos are fine) or by description, with links to the lines |
| `/edit` | Changes the open or selected code, or a method you name (`/edit OrderService.place add input checks`), with the local model. Follow-ups like *"can you add them"* after `/explain` also work. You see a diff and nothing changes until you click **Apply**. You can also **Try another local model** or **Escalate** (opt-in, names removed). |
| `/improve` | Asks the local model for real improvements to the open file (bugs, safety, clarity), shows a diff and a summary, and after **Apply** offers to open a pull request |
| `/pr` | Commits your changes to a new branch, pushes it and opens a pull request (`gh`, or a GitHub link). Asks first and stops if it finds credentials. |
| `/review-changes` | Reviews your uncommitted changes |
| `/scan` | Reviews the whole project: AI, Semgrep, Gitleaks, the optional analyzers, built-in rules, data flow and CVEs |
| `/scan-changed` | Same as `/scan`, but only for files that changed since the last scan |
| `/security` | Fast project security scan without AI: rules, credentials, and request input that reaches SQL, shell, eval, files or URLs |
| `/secrets` · `/gitleaks` | Finds hardcoded passwords and keys (values are hidden). `/gitleaks history` also checks every past git commit |
| `/dependencies` | Finds CVEs with Trivy and OSV-Scanner and shows whether your code calls the vulnerable function |
| `/test` | Runs the project tests |
| `/auto` | Sends a typed question that contains no code to the right model |
| `/escalate` | *Opt-in.* Sends only the selected function to a Copilot model, with names removed and after you approve it (see below). Type `/escalate on` or `/escalate off` to allow or block it |

**Without Chat** (Cursor, Windsurf, VSCodium, or Chat turned off): the main commands are also in the Command Palette, for example **Hushavyr: Review Current File**, **Scan Project**, **Security Scan (No AI)**, **Find Hardcoded Secrets** and **Check Dependencies for CVEs**. The report opens as a Markdown preview with links to each line, and the findings appear in the **Problems** panel. *Review* and *Explain* are also in the editor's right-click menu.

**Fix a finding with local AI (AI auto-fix with approval):** use the 💡 **Fix with local AI** quick fix on any Hushavyr finding in the Problems panel (SQL injection, XSS, command injection, path traversal, hardcoded secrets, review issues), click **Fix or dismiss a finding** after any Chat report (`/scan`, `/security`, `/secrets`, `/dependencies`, `/gitleaks`), or run **Hushavyr: Fix or Dismiss a Finding**. Pick the finding, then **Fix with local AI**, **Explain** or **Dismiss**. The local model writes the change, Hushavyr opens a side-by-side diff, and the file changes only after you click **Apply fix** (undo with Cmd/Ctrl+Z).

**Dependency CVEs get a fix too:** every row shows the exact command (`npm install lodash@4.17.21`, `go get …`, `"overrides"` for a transitive package, `<dependencyManagement>` in Maven, …). **Fix with local AI** edits the manifest: a direct version is bumped exactly, a transitive one gets an override written by the local model, and the diff waits for your approval. Then run the shown command (for example `npm install`) to refresh the lockfile.

**Explain a finding with local AI:** after `/security` or `/secrets` (or their palette commands), click **Explain a finding**, or use the 💡 quick fix on any Hushavyr finding. The scanner result stays unchanged; the local model explains what it means in that exact code, whether it looks real, and suggests a minimal fix.

**Fresh CVE data:** every dependency report shows how old the Trivy and OSV databases are. If one is over a day old, Hushavyr offers **Update now**; **Hushavyr: Update Vulnerability Databases** updates both. **Hushavyr: Setup** turns on the daily update (`aiPrivacyRouter.autoUpdateVulnDb`, checked by default); in the terminal use `/update-db`, or `/update-db auto on`. Only the public CVE database is downloaded; your code and dependency list never leave the machine.

Quick fixes on findings:
- **Explain this finding (local AI):** context-aware explanation and a suggested fix, next to the original scanner result.
- **Fix with local AI:** on every Hushavyr finding; shows a diff, and nothing changes until you approve it.
- **Prove with a failing test:** runs a generated test in an offline Docker container (Java/Maven, Python/pytest, JavaScript/TypeScript, Go). The bug counts as confirmed only if that test fails.
- **Not a real issue:** hides the finding for the whole team.

## Team files (commit them)

| File | Purpose |
| --- | --- |
| `.hushavyr/rules.md` | Your team standards, e.g. "never log tokens". `/review` checks the code against them. |
| `.hushavyr/dismissed.json` | False positives hidden for everyone, in reviews, scans and dependency reports. Created by the *Not a real issue* quick fix, **Dismiss** or `/dismiss N` in the terminal. |
| `.hushavyr/ignore` | Paths that are never scanned, one per line (`src/test/`, `*.gen.ts`). Use it for intentionally vulnerable test fixtures. |
| `.hushavyr/taint-rules.json` | Your own request sources, sinks and sanitizers for the data-flow engine (`/scan`, `/security`, CLI), e.g. an in-house DB wrapper. |

```json
{
  "sources": [{"pattern": "\\bctx\\.input\\(", "languages": ["ts", "js"]}],
  "sinks": [{"kind": "sql", "call": "db\\.unsafeQuery", "arg": 0}],
  "sanitizers": ["toSafeId"]
}
```

Patterns are regular expressions on code (string literals are blanked); `call` and `sanitizers` name the function, `(` is added. `kind` is one of `sql`, `nosql`, `command`, `code`, `path`, `ssrf`, `xss`, `ldap`, `xpath`, `trust-boundary`, `redirect`, `xxe`, `deserialization`; `arg` is the argument index or `"all"`; `languages` are file extensions (default: all). The CLI stops with exit code 2 on an invalid file.

## CI

- **Project scan:** run `node dist/cli.js . --sarif hushavyr.sarif --fail-on high` and upload the SARIF to GitHub code scanning. See `.github/workflows/hushavyr-scan.yml`.
- **Benchmark:** results of the CLI scan on the public OWASP Benchmark for Java are in [docs/owasp-benchmark.md](docs/owasp-benchmark.md), and for Python in [docs/owasp-benchmark-python.md](docs/owasp-benchmark-python.md).
- **PR review:** copy `examples/hushavyr-pr-review.yml` into your workflows. It runs on a self-hosted runner with Ollama, reviews only the changed lines and comments on the PR.

## Hushavyr compared with cloud AI review

| | Hushavyr | Typical cloud AI code review |
| --- | --- | --- |
| Where your code goes | Stays on your machine (Ollama) | Sent to the vendor's servers |
| Price | Free, MIT licensed | Usually a subscription per seat |
| Works offline / air-gapped | Yes | No |
| Security scan without AI (rules, data flow, secrets, CVEs) | Yes | Varies |
| Proves a fix with a failing test | Yes, in an offline Docker sandbox | Rarely |
| Output for CI | SARIF, CLI exit codes, PR comments | Varies |

**Measured:** on Hushavyr's 51 benchmark fixtures (bugs and clean twins in Java, JavaScript, TypeScript, Python, Go and C#; synthetic code, not real projects), with the same instruction for every model:

| Reviewer | Precision | Recall |
| --- | --- | --- |
| Hushavyr, `qwen2.5-coder:14b` on a laptop | 0.95 | 0.73 |
| GPT 6.1 (cloud) | 0.81 | 0.96 |
| Claude Sonnet 5.5 (cloud) | 0.72 | 1.00 |

Hushavyr reports fewer false alarms; the cloud models miss fewer bugs. Run it yourself with `node dist/benchmark.js` and `node benchmarks/cloud-reference.mjs`.

## FAQ

**Is Hushavyr a free GitHub Copilot alternative for code review?**
Yes, for code review and security. It works in the VS Code Chat as `@ai-privacy`, but the model runs locally with Ollama, so it is free and private. It does not replace Copilot's inline completions.

**Can it fix security vulnerabilities automatically?**
Yes, with your approval. **Fix with local AI** asks the local Ollama model for a minimal fix (a parameterized query for SQL injection, output encoding for XSS, an environment variable for a hardcoded password), shows the diff, and edits the file only after you click **Apply fix**. To be sure the fix works, **Prove with a failing test** runs a test before and after the fix in an offline Docker sandbox and can open the pull request.

**Is there a Hushavyr CLI for the terminal, like Copilot CLI?**
Yes. Type `hushavyr` in the VS Code terminal to chat with the local AI about your code, run `/security`, `/secrets`, `/dependencies` and `/review`, fix findings with `/fix N` behind a diff you approve, prove a fix with a failing test (`/prove`), scan git history (`/gitleaks history`) and open a pull request (`/pr`). Everything runs locally; only `/escalate`, which is off by default, can send an approved, pseudonymized fragment to GitHub Copilot. For other terminals, run **Hushavyr: Install 'hushavyr' Command in Terminal PATH** once. See [Use it in the terminal](#local-ai-cli-for-the-terminal-hushavyr).

**Does my code leave my computer?**
No. Review, scanning and fixes run locally, and there is no telemetry. Only the opt-in `/escalate` sends anything: a selection with names replaced by tokens, and only after you approve the exact text.

**Which model should I use?**
Setup picks one for your RAM: `qwen2.5-coder:7b` under 20 GB, `14b` for 20–30 GB, and `qwen3-coder:30b` from 30 GB up. See [Models and memory](#models-and-memory).

**Does it scan git history for leaked secrets and API keys?**
Yes, on request: `@ai-privacy /gitleaks history` or **Hushavyr: Find Secrets in Git History** runs Gitleaks over every commit, locally, with values redacted. Each finding shows the commit. A secret removed later is still exposed in history, so rotate it if it is real. Once a secret is rotated, add its fingerprint to `.gitleaksignore` and it stops being reported. Secrets in tests, fixtures, examples and docs are still reported, at lower severity.

**Will it detect a CVE published today?**
Yes, once the local CVE database is updated. Scans run offline against a downloaded copy of the public Trivy and OSV.dev databases, which are refreshed every few hours. Each report shows the database age, offers **Update now** when it is over a day old, and `aiPrivacyRouter.autoUpdateVulnDb` keeps it fresh automatically.

**Can I use it without AI?**
Yes. `/security`, `/secrets` and `/dependencies` are deterministic and need no model. The `hushavyr-scan` CLI runs the same checks in CI and writes SARIF for GitHub code scanning.

**How accurate is it?**
On our synthetic benchmark the built-in rules find every planted issue with no false alarms. On the external [OWASP Benchmark for Java](docs/owasp-benchmark.md) the scanner scores **97.2% with 0% false positives** (every category 100% except weak hashing, 69%). On the [OWASP Benchmark for Python](docs/owasp-benchmark-python.md) it scores **100% with 0% false positives**. That suite is small and formulaic, and its patterns were studied while the rules were written. Real projects are messier than any benchmark, so we also scan [six intentionally vulnerable apps](docs/real-world-benchmarks.md): OWASP Juice Shop (TypeScript), WebGoat (Java), DVWA (PHP), RailsGoat (Ruby on Rails), GoVWA (Go) and WebGoat.NET (C#). The page lists what is found, the known false positives and the misses. On [Juice Shop](docs/juice-shop-benchmark.md) 37 of 38 HIGH findings are real and test passwords are reported as MEDIUM. No tool is perfect. Findings are potential issues; check them before acting.

**Does it work in Cursor, VSCodium or Windsurf?**
Yes. Install it from [Open VSX](https://open-vsx.org/extension/mathias82/hushavyr). The `@ai-privacy` chat commands need the VS Code Chat API (VS Code 1.90 or later), which other editors may not support, but every main feature is also a Command Palette command, and the `hushavyr-scan` CLI works everywhere.

## Privacy

- Review, scanning and code search run only on your machine. There is no automatic cloud fallback. The search index stays outside your repository.
- `/escalate` is off unless you turn on `aiPrivacyRouter.cloudEscalation`. When it is on:
  - It sends only the selection, up to 4,000 characters.
  - Names, strings and comments are replaced with tokens such as `id1` or `s1`. The mapping stays on your machine.
  - It is blocked for secrets, personal data, `.env`/key files, ignored files and local-only workspaces.
  - You see the exact text before anything is sent, and every send is written to a local audit log.
  - The answer is a suggestion: verify it locally.
- To turn it on, type `@ai-privacy /escalate on` in chat and confirm (`/escalate off` turns it off). It is saved to the open workspace's settings, or to your User settings if no folder is open. You can also tick `aiPrivacyRouter.cloudEscalation` in Settings (`Cmd+,` / `Ctrl+,`). In the `hushavyr` terminal, use `/escalate on`. It stays blocked while `aiPrivacyRouter.mandatoryLocalOnly` or `chat.disableAIFeatures` is on, in untrusted workspaces and in remote (SSH, container) sessions; the chat lists which of these applies.
- **When the local model may be wrong**, Hushavyr says so and offers to ask Copilot about that exact code. This happens when the local checks disagree on a finding, findings have no matching code, complex code (concurrency, deep nesting, 120+ lines) gets a clean review, the answer hedges ("I'm not sure"), you ask "are you sure?", or the model fails. In chat you get an **Ask Copilot (pseudonymized, needs approval)** button; in the terminal a `y/N` question (default No). Both go through the same preview and approval as `/escalate`. Nothing is suggested while escalation is blocked (see the previous point). Turn suggestions off with `aiPrivacyRouter.suggestEscalation: "never"`, or `/escalate suggest off` in the terminal.
- Recommended: keep it off in **User** settings and turn it on per project in **Workspace** settings, only for code you may share (your own or open source). For company or client code, set `aiPrivacyRouter.mandatoryLocalOnly` to `true` in that workspace so it can never be turned on there.
- Findings are potential issues. Check them before acting.
- No telemetry. **Hushavyr: Report an Issue** shows a redacted report (versions, OS, settings without endpoints or paths) and opens a GitHub issue only if you click it.

More details are in the [user guide](docs/guide.md). The stable API and versioning policy is in [docs/stability.md](docs/stability.md).

**Author:** Matthaios Stavrou · [GitHub](https://github.com/mathias82/Hushavyr)
