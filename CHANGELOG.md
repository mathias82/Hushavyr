# Changelog

## 1.0.11
- **CVE databases stay current:** Setup offers **Update CVE databases daily** (checked by default). Before a dependency scan, Hushavyr then downloads the latest public Trivy and OSV data when it is over a day old. No code or dependency list leaves the machine.
- **Terminal `/update-db`:** downloads the databases now. `/update-db auto on|off` controls the daily update, and `/setup` asks about it (Enter means yes).
- **Trivy Java database:** Setup and every update also download it, so CVEs inside `.jar` files are found.

## 1.0.10
- **Setup works the same on Linux and Windows:** analyzers are only offered when this machine can install them (Homebrew on macOS or Linux, otherwise pipx or go). The rest are listed with an install link instead of failing as a setup step. On Windows, setup installs Ollama and the model only.
- **Ollama key repair on Windows too:** the missing-key case is recognized from the Windows error text. On Linux, the hint says `sudo systemctl restart ollama`.

## 1.0.9
- **Setup repairs Ollama's missing key:** if `~/.ollama` was deleted while Ollama kept running, every model download failed until a restart. Setup now writes a fresh key and retries the download.
- **Setup errors say what went wrong:** a failed model download shows Ollama's own error instead of "Check Ollama and disk space".
- **Fewer false setup failures:** the OSV database step succeeds when the database was downloaded, even if the project has vulnerabilities (osv-scanner exits non-zero then). A failed model download no longer skips the analyzer installs.

## 1.0.8
- **Every finding can be fixed or dismissed:** after `/scan`, `/security`, `/secrets`, `/dependencies` and `/gitleaks`, **Fix or dismiss a finding** lets you pick one, then fix it with local AI (diff to approve), explain it, or dismiss it. Dismissed findings (`.hushavyr/dismissed.json`) are now hidden from scans and dependency reports as well, not only from reviews.
- **Dependency CVEs get a concrete fix:** each row shows the exact command or edit per ecosystem (npm, yarn, pnpm, pip, Poetry, uv, Go, Cargo, Composer, Bundler, Maven, Gradle, .NET); transitive packages get an override or constraint instead of a direct install. **Fix with local AI** upgrades the package in the manifest behind a diff: an exact bump when the version is declared, otherwise an override written by the local model and checked (valid JSON, fixed version present).
- **Setup installs the `hushavyr` terminal command** (checked by default) so it also works in Terminal.app, iTerm and Windows Terminal, not only in VS Code terminals.
- **Terminal:** `/fix N` works on dependency findings, new `/dismiss N [reason]`, and the banner no longer shows a version (`hushavyr --version` still does).

## 1.0.7
- **Marketplace page:** questions go to GitHub Issues; clearer README headings for the terminal CLI and the VS Code Chat commands, and an HD link to the terminal demo.

## 1.0.6
- **`hushavyr` in the terminal:** a local AI coding assistant like a private Copilot CLI. Type `hushavyr` in any project to chat about your code (mentioned files are included), run `/security`, `/secrets`, `/dependencies`, `/scan` and `/review`, fix a finding with `/fix N` or change code with `/edit`, both behind a colored diff you approve (`/undo` reverts), explain with `/explain`, switch models with `/model`, and install everything with `/setup`. Works in VS Code terminals right after install, with no Node.js needed; **Hushavyr: Install 'hushavyr' Command in Terminal PATH** adds it to every other terminal on macOS, Linux and Windows.
- **Terminal parity with VS Code:** `/gitleaks history` (secrets in every commit, redacted), `/prove N` (regression test that fails, fix that makes it pass, in an offline Docker container, both approved; the verified patch is applied only on `y`), `/pr` (commit, push and open a pull request; blocked when a changed file looks like it has a secret) and opt-in `/escalate` (off by default; shows the exact pseudonymized fragment and sends it to GitHub Copilot through the Copilot CLI only after approval, never through a shell).
- **Safer AI fixes:** when the model returns only the fixed line instead of the whole window, the fix now replaces just that line. Before, the diff could delete the surrounding lines. Applies to the terminal and to **Fix with local AI** in VS Code.
- **Syntax trees for JS/TS, PHP, Go, C# and Ruby** (tree-sitter, bundled WASM, as Java already had): exact function boundaries and parameters, and commented-out code is ignored. Finds the RailsGoat file-upload path traversal (`Benefits.save`); drops a WebGoat.NET SQL finding that was inside a `/* */` comment. Minified bundles (`*.min.js`) are no longer taint-analysed, so their short function names do not capture the application's calls.
- **`if` guards count as validation in every language:** `is_numeric`, `ctype_digit`, `filter_var(..., FILTER_VALIDATE_INT)`, `in_array`/`includes` allow-lists and anchored regex checks (`preg_match('/^[a-z]+$/', $x)`, `/^\d+$/.test(x)`, `x.matches("[0-9]+")`, `Regex.IsMatch`) make a value safe inside the guarded block, or after an `if (!check) return;`. Removes the DVWA `exec/impossible.php` false positive; unanchored or `.*` patterns still count as tainted.
- **Declared receiver types in JS/TS and Go:** `this.commandBus.execute(...)` (`commandBus: CommandBus`) or `cache.Exec(k)` (`cache *redis.Client`) is no longer reported as SQL injection; receivers typed as a database handle (`Pool`, `Knex`, `DataSource`, `*sql.DB`, `*gorm.DB`) or untyped are still checked. Syntax trees of unchanged files are reused across scans.
- **One-click setup:** **Hushavyr: Setup** now installs and starts Ollama, downloads the model and installs every missing dependency and security analyzer (Semgrep, Gitleaks, Trivy, OSV-Scanner, FindSecBugs, Bandit, gosec) with the Trivy and OSV databases, after one confirmation that lists every command. Before, it stopped after installing Ollama and asked about each tool separately.
- **Your own data-flow rules:** `.hushavyr/taint-rules.json` adds request sources, sinks and sanitizers (an in-house query wrapper, a framework's input accessor) to `/scan`, `/security` and the CLI. The built-in rules moved to `src/taintRules.ts`.
- **Fix any finding with local AI:** the 💡 **Fix with local AI** quick fix now appears on every Hushavyr finding (scanner, data-flow, secrets, review), not only on AI review markers; also **Hushavyr: Fix a Finding with Local AI** and a **Fix a finding** button after Chat and palette reports. The proposed change opens as a read-only side-by-side diff and is applied only after **Apply fix**. Dependency CVEs keep the **Upgrade** quick fix.
- **CI benchmark gate:** every push re-scans six pinned real-world apps (`npm run benchmark:realworld`) and the OWASP Benchmark, and fails on any lost or new finding or a score drop.

## 1.0.5
- **PHP, Go, C# and Ruby data-flow tracking:** request input (`$_GET`, `r.FormValue`, `Request.Form`, `params[...]`) is followed to SQL, command, file, URL, redirect, XSS, LDAP, XPath, code and deserialization sinks, including string interpolation (`"$id"`, `"#{id}"`, `$"{id}"`), Go `:=` and prepared statements, and Rails hash conditions as safe.
- **JS/TS gaps closed:** MongoDB `$where` NoSQL injection, Zip Slip, XXE (`noent`, `XML_PARSE_NOENT`), Angular `bypassSecurityTrust*`, `node:vm` as a sandbox, `res.redirect`.
- **New rules for Go, C#, PHP and Ruby:** `fmt.Sprintf` and C# SQL concatenation, `BinaryFormatter`/`TypeNameHandling`, weak hashes, ciphers and random numbers, `extract($_GET)`, `[ValidateInput(false)]`, disabled Rails CSRF checks and `permit!`.
- **Real-world benchmarks:** results on Juice Shop, WebGoat, DVWA, RailsGoat, GoVWA and WebGoat.NET in [docs/real-world-benchmarks.md](docs/real-world-benchmarks.md). OWASP Benchmark unchanged: Java 97.2%, Python 100%, 0% false positives.
- **Less noise on real repos:** translations in non-Latin scripts (e.g. `"LABEL_PASSWORD": "パスワード"`) are no longer reported as credentials; the CLI/SARIF reports credentials in tests, fixtures and docs as `warning`, as the editor already did. On OWASP Juice Shop HIGH findings went from 220 to 35, 34 of them real ([report](docs/juice-shop-benchmark.md)).

## 1.0.4
- **Git history secret scan:** `@ai-privacy /gitleaks history` or *Hushavyr: Find Secrets in Git History* scans every commit with Gitleaks, locally. Each finding shows its commit, so secrets that were deleted but are still in history get found. Rotated secrets can be silenced with `.gitleaksignore`.
- **Redacted always:** Gitleaks runs with `--redact`, so secret values never reach reports or the model.

## 1.0.3
- **Without Chat:** every scan and review is also a Command Palette command (and in the editor right-click menu); reports open as Markdown previews and findings go to the Problems panel. Works in Cursor, VSCodium and Windsurf.
- **Explain a finding (local AI):** after `/security`, `/secrets` or the palette scans, pick a finding (or use the 💡 quick fix) and the local model explains it in the context of that code and suggests a fix. The scanner result stays unchanged.
- **Fresh CVE data:** reports show when the Trivy and OSV databases were last updated; one command, *Hushavyr: Update Vulnerability Databases*, refreshes both; an offer appears when they are older than a day; optional `aiPrivacyRouter.autoUpdateVulnDb`.
- **Model choice:** Setup lists the models already installed in Ollama, the recommended ones, and *Other…* for any Ollama model name. The list never comes from the internet.
- **Python rules:** taint tracking and rules for Python; OWASP Benchmark for Python 100% (0% false positives), Java 97.2%.
- **Open VSX:** published there as well.
- **Fixes:** links in Markdown reports open at the right line; review evidence uses the file's language for highlighting; the chat Explain button works with VS Code's frozen response stream.

## 1.0.2
- **README:** link to the HD demo video.
- **Marketplace:** clearer name and description, more precise search keywords.
- **`/dependencies`:** the lockfile hint also shows when Trivy is missing.

## 1.0.1
- **Live answers:** `/explain` and plain questions stream as they are written; `/review` shows each pass and adds findings one by one.
- **`/review`:** flows proven by taint tracking and SQL sinks built with `SELECT *` are kept; locations are relative to the workspace; `<` and `>` in model text stay visible.
- **`/edit`:** change summaries keep comparison operators.
- **`/test`:** offers only the test runners the project uses (npm, Maven, Gradle, pytest).
- **`/auto`:** plain questions are no longer blocked by VS Code's attached skill index.
- **`/secrets` and `/scan`:** Stripe, AWS, GitHub, Slack and Google tokens and private keys are found whatever the variable is called.
- **`/dependencies`:** manifests in direct subfolders (`api/`, `backend/`) are scanned; a `package.json` without a lockfile gets a clear hint.
- **`/scan-changed`:** says when nothing changed since the last scan instead of reporting inconclusive coverage.
- **`/pr`:** the change summary lists new, untracked files.
- **Setup:** detects the OSV-Scanner v2 offline database.
- **README:** demo GIF of install, setup and every chat command; working Marketplace badges.

## 1.0.0
First stable release. The public surface (chat commands, command ids, settings, CLI flags and exit codes, SARIF output) is now covered by the [stability policy](docs/stability.md).
- **OWASP Benchmark for Java: 97.2% with 0% false positives.** Every category scores 100% except weak hashing (69%), where the algorithm is read from a properties file outside the scanned code.
- **Tree-sitter Java analysis:** methods, parameters and annotations come from a real syntax tree, and calls resolve by the receiver's declared type, so a project method named `execute` or `query` is no longer mistaken for a database call. Falls back to the line-based engine when a file does not parse.
- **Fewer false alarms on real code:** method declarations are not sinks, locals of one method no longer taint another, `System.out` is not a web response, static helper calls are not JDBC, ambiguous names and other languages are not followed, and `Math.random()` is reported only near tokens, passwords, cookies or keys.
- **Light mode for 8 GB machines:** `aiPrivacyRouter.reviewDepth` defaults to `auto`: thorough from 20 GB, fast from 12 GB and a new `light` mode below. Light mode uses `qwen2.5-coder:3b`, one short pass and an 8k context, while the built-in rules and the verifier carry the rest. The CLI accepts `hushavyr-review --light`.

## 0.0.32
- **More optional offline analyzers:** FindSecBugs (SpotBugs, compiled Java/Kotlin classes), Bandit (Python), gosec (Go) and OSV-Scanner (dependency CVEs, offline database only) feed `/security`, `/scan`, `/dependencies`, the CLI and SARIF with `findsecbugs-`, `bandit-`, `gosec-` and `osv-` rule ids. Only medium/high findings outside tests are kept, each line is reported once, and OSV CVEs already found by Trivy are not repeated. Missing tools are skipped; Setup offers them for matching projects and asks before downloading the OSV database.
- **Go verified fixes:** choose **Go / go test** to reproduce a bug with a generated failing Go test and verify the fix in offline Docker:
  - Uses `aiPrivacyRouter.fixGoImage`, default `golang:1.24`.
  - Uses the module cache in read-only mode, or the cache set in `aiPrivacyRouter.fixGoModCache`.
  - Sets `GOPROXY=off` and runs with no network.
- **Report an Issue:** a new opt-in command. It shows a redacted report (versions, OS, settings without endpoints, paths or private registries). It opens a prefilled GitHub issue only when you click it. There is no telemetry.
- **OWASP Benchmark for Java:** `npm run benchmark:owasp` scores the CLI scanner on an external benchmark. Results are in `docs/owasp-benchmark.md`.
- **VS Code end-to-end tests:** `npm run test:e2e` runs activation, commands, settings, privacy preview and SARIF export in a real VS Code. CI runs them too.
- **Credential severity:** hardcoded credentials in tests, fixtures, docs, examples and local/dev config files are now MEDIUM. Credentials in production code and config stay HIGH.
- **Models and memory:** setup recommends `qwen3-coder:30b` with 30 GB or more RAM; it is a MoE model, so it runs faster than a dense 30B model. **Start Ollama** turns on flash attention and an 8-bit KV cache, which use less memory. The README has a RAM table.
- **Stability policy:** `docs/stability.md` lists the API that becomes stable at 1.0 (chat commands, command ids, settings, CLI, SARIF, team files, proof receipts) and the deprecation rules.
- **Internal:** `extension.ts` and `workspaceScan.ts` are split into smaller modules; behavior is unchanged.
- **Rust rules:** new built-in rules for Rust code.
- **Fewer false credential findings.**
- **Pull requests:** the PR receipt check now runs the same strict proof validation that verified fixes use.

## 0.0.31
- `/edit` and follow-ups like "can you add them": the local model changes the open or selected file. You see a diff, nothing changes until **Apply**, and Apply refuses if the file changed meanwhile. **Try another local model** reruns it with any installed Ollama model. **Escalate** sends it to Copilot pseudonymized (opt-in).
- `/pr`: commits to a new `hushavyr/...` branch, pushes it and opens a pull request with `gh`, or gives a GitHub compare link. Asks first and blocks credentials.
- Fewer false credential findings: key names like `hashAlgorithm` and `secretProviderClass`, env and config lookups, resource refs and UI text are no longer reported. Across 21 real repos, credential findings dropped from 1405 to 420.
- The CLI maps Semgrep rule IDs to Hushavyr IDs and removes duplicates. On the synthetic benchmark, precision went from 0.43 to 0.96 and recall from 0.45 to 1.00.

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
