# Changelog

## 1.0.22
- **Copied-in JavaScript libraries:** `/dependencies` now finds libraries copied into the project instead of installed (for example `jquery-1.11.3.min.js` or a `DataTables-1.10.12/` folder), reads their version from the license banner, and checks them offline with Trivy. Supported: jQuery, jQuery UI, Bootstrap, DataTables, Moment, AngularJS, Handlebars, Underscore, Knockout, Select2. The fix advice is to replace the file with a fixed release. Hushavyr never asks the model to edit a library file. Before this, a PHP project with only copied-in libraries showed "No supported dependency manifest found".
- **Commit, and commit and push, without a pull request:** `/commit [message]` in the terminal, or "commit" / "κάνε commit" in VS Code chat, commits every change on the current branch with a message the local model writes from the diff. `/push [message]`, "commit and push" / "kane commit kai push", or the chat **Commit and push** button also push that branch to origin, with no pull request. Both ask first, stop on secrets, and work for the first commit of a new repository. In chat an open file no longer blocks the request with "Context exceeds 20 KB".
- **`/pr` in a repository without commits:** makes the first commit on the current branch and pushes it as the base branch (a pull request needs one), instead of failing with a git error about `HEAD`. The next `/pr` opens a pull request.
- **Model download behind a company proxy:** when a proxy or firewall answers instead of ollama.com, Hushavyr now says the network blocks the download and how to get around it (another network, `HTTPS_PROXY` for `ollama serve`, or asking IT to allow `registry.ollama.ai`), instead of printing the proxy's HTML page.
- **Models from Hugging Face:** model size is now read from names such as `hf.co/<user>/<model>-30b-…-GGUF:Q4_K_M` or `…-14B-…`, so these models get the same second-pass and review-depth defaults as the Ollama library model of that size.
- **Per-method review pass (experimental):** `HUSHAVYR_PER_METHOD=1` adds one review pass per function. Off by default: on the tuned fixtures it found no extra bugs with the 30b model (F1 0.84 both ways) and took twice as long.

## 1.0.21
- **`/review diff` (terminal):** reviews only your uncommitted changes. Each changed line is widened to the method around it, so a small change in a large file is reviewed in seconds. New files are reviewed whole.
- **VS Code `/review-changes`:** sends only the changed methods (with a few lines around them) to the local model, with their real line numbers, instead of whole files.
- **qwen3-coder:30b from 24 GB:** setup now recommends the 30b mixture-of-experts model on machines with 24 GB or more (was 30 GB). Measured on a 24 GB Mac: about 20 GB of memory, 6 s per benchmark case (14b: 12 s). If you never chose a model and the 30b is not downloaded, VS Code keeps using the model you already have instead of starting a 19 GB download; pick the 30b in **Hushavyr: Setup**.
- **30b in one pass:** the extra security and robustness passes found no more bugs with the 30b model, only more false positives (precision 0.70 versus 0.78) in 2.5 times the time, so `reviewDepth: auto` runs one pass for 30b and larger models.
- **30b without the second pass:** the 30b model's findings are no longer re-checked by a second local pass, which mostly dropped real bugs. Tuned fixtures: precision 0.78, recall 0.92 (was 0.80 / 0.82), twice as fast.
- **`/fix` no longer deletes the next method's signature:** when the local model returned only the fixed method instead of the whole excerpt, the lines it left out (for example the next method's first line) were deleted. Now only the span the answer covers is replaced. Same in VS Code.
- **README benchmark:** tuned (96) and held-out (120) scores per model (30b, 14b, 7b, GPT 6.1, Sonnet 5.5) and F1 per language. The cloud models are still clearly ahead on unseen code; the 30b is the best local model (held-out F1 0.54, 14b 0.27).
- **Benchmark:** 96 new held-out fixtures (16 per language), never used for tuning, so 216 fixtures in total. `CLOUD_IDS=<regex>` runs the cloud reference on a subset, `CLOUD_RAW=<file>` keeps the raw cloud answers. A clean held-out fixture (`token-refresh-race-clean`) still had a real race and was fixed.

## 1.0.20
- **Chat `/review` → Fix:** after a review with findings, Chat shows **Fix or dismiss a finding** and **Explain a finding** buttons, as after a scan. Before, the fix was only reachable through the Quick Fix on the marked line.
- **README:** the top demo now shows the chat Fix button (`/review` → Fix → diff → Apply), with an HD MP4.

## 1.0.19
- **README:** new short demo at the top (`/review` → Quick Fix → diff → Apply) and an install demo (Marketplace → Setup) under Install. The full tour moved below them.
- **Benchmark: where each bug is lost.** Every case now has a stage trace: what the general pass, retry, lenses, static rules, verifier, recheck, targeted checks and judge proposed, kept or dropped, model calls per stage, failed requests and invalid JSON answers. Each missed bug gets a `lossStage` (`not_proposed`, `validator_rejected`, `merge_dropped`, `verifier_rejected`, `possible_only`, `wrong_location`, `wrong_mechanism`, `inconclusive`, ...) and each final finding its origin stage. `not_proposed` is reported only when no model request failed and every answer was valid JSON. Expected bugs are used for scoring only and never reach the model. The trace holds line numbers and titles, no source or fix text. `BENCH_TRACE=0` turns it off. Measurement only: findings, scores and model calls are unchanged.

## 1.0.18
- **`/pr` writes the text for you:** without a title, the local model reads the diff of the files to commit and proposes a Conventional Commit message, a PR title and a body (what, why, tests). Accept, edit or cancel; the secrets check still runs first. Same in the terminal and in VS Code.
- **"Possible (low confidence)" section:** findings the second local check disputes are no longer dropped silently. They are listed separately after the confirmed findings, and `/fix` works on them.
- **Targeted checks:** code that looks like a known bug class (integer overflow, sort without comparator, missing `await`, `|| default` on a value that may be 0, use before a null check, null returned from another file) gets one focused yes/no question to the local model (at most 3 per review).
- **32b judge (optional):** if `qwen2.5-coder:32b` is already installed, the machine has at least 48 GB of RAM and the main model is smaller, the 32b model decides only the disputed findings. Setting `aiPrivacyRouter.reviewJudge` / terminal config `reviewJudge` (`auto` or `off`).
- **Fewer speculative findings:** "can throw" / "may throw" claims without a concrete cause, Go errors that are checked right there, and division by a value already checked for zero are no longer reported.
- **Second check per model:** 7b and smaller models check only findings they state as possibilities ("Potential …", "may …"); a full second pass made them drop their real bugs. 7b: precision 0.83, recall 0.49 (was 0.45 / 0.61 without a check, 1.00 / 0.16 with the full check). 14b and larger keep the full check.
- **Benchmark:** 120 fixtures (about 20 per language, bugs and clean twins) with 24 held-out fixtures never used for tuning. qwen2.5-coder:14b: precision 0.67, recall 0.77 (0.82 with the Possible section), held-out 0.46 / 0.50. GPT 6.1 on the same fixtures: 0.75 / 0.95. Per model and per language in the README. The 32b model could not be measured on 24 GB (over 5 minutes per review).
- **VS Code `/secrets`:** configuration files up to 200 KB are checked, as in the terminal (was 60 KB, and larger files were counted as checked). The summary names the files it skipped.
- **Terminal `/dependencies` and `/scan`:** when the offline CVE database is missing, the result says so and points to `/update-db` instead of only "No findings".
- **README:** "Language model unavailable" in VS Code Chat means no chat model is set up; the Command Palette and the terminal work without one.
- **Fixes:** a slash command typed at a `y/N` question now runs instead of being taken as the answer; a class name no longer asks "Which one?" between the class and its constructors; the hardcoded-credential message is no longer repeated; the VS Code test instance no longer rewrites your `~/.local/bin/hushavyr`.
- **No more hanging chat answers:** `/explain`, questions, `/auto` and the per-file model step of `/scan` now send the same context size as reviews. A different size made Ollama reload the model, which could hang every later answer ("Local request failed" after 180 s, `/scan` "0/22 files").
- **`/fix` on multi-statement fixes:** when the model's few-line fix cannot be placed safely (e.g. SQL injection, which needs a `PreparedStatement` and a bound parameter), Hushavyr asks it to rewrite only the enclosing method and shows that diff to approve. Terminal and VS Code.
- **Terminal finding numbers stay right after a fix:** lines of other findings in the same file move with the change; a finding whose code was rewritten says so instead of fixing the wrong line. `/undo` restores them.
- **`/edit` and `/improve` diffs:** one hunk per change with real file line numbers, instead of every line between the first and last change.

## 1.0.17
- **Code organized by responsibility:** `src/` is split into `review`, `scan`, `deps`, `fix`, `escalation`, `model`, `search`, `parsing`, `git`, `vscode` and `terminal`, with tests in matching folders. `ARCHITECTURE.md` describes each package. Behavior is unchanged: all tests, the static benchmark gate and the real-world scan give the same results as 1.0.16.

## 1.0.16
- **Find code by name or description, everywhere:** `/find` in the terminal and in VS Code Chat. `/review`, `/explain` and `/edit` accept a class or method name (`OrderService.place`, typos like `order servce` are fine) or a description (`the code that sends the confirmation email`). `/edit` on a method changes only that method. Free questions that name code include it; "describe the project" uses a local overview (README, build files, folders, main types). The terminal reads only the folder it was started in.
- **Search by meaning (optional):** with the local `nomic-embed-text` model (the terminal asks once). The index lives in `~/.hushavyr/index`, never in the repository.
- **Fewer false alarms:** precision 0.95 and recall 0.73 on 51 fixtures in six languages (was 0.86 / 0.73 on the same fixtures before this release). Same finding within one line is reported once; `yaml.safe_load` and Python `None` defaults are no longer flagged. New Semgrep rule for C# SQL concatenation; Go SQL concatenation with quotes is caught.
- **Benchmark:** 51 fixtures (Go and C# added), results per language, and `benchmarks/cloud-reference.mjs` to compare with cloud models on the same fixtures only.
- **Terminal:** plain `exit` or `quit` quits.
- **No more review timeouts on looping answers:** each review pass is capped at 2048 tokens, and a cut-off answer keeps its complete findings instead of failing.

## 1.0.15
- **Fewer, more useful Copilot suggestions:** a finding dropped by the second check gets one narrow recheck of the lines around it. Only when the two local checks disagree does the review name it ("possible issue the local checks disagree on … at line N") and offer `/escalate` for that line. Benchmark (qwen2.5-coder:14b): suggestions on correct reviews fell from 11/26 to 3/26; precision and recall unchanged (0.76 / 0.72).

## 1.0.14
- **Suggests Copilot when the local model may be wrong:** after a review, explanation or chat answer, Hushavyr names why the answer may be wrong (second check rejected findings, findings without matching code, clean review of complex code, hedging, "are you sure?", model failure) and offers to ask Copilot about that exact code. Chat shows a button, the terminal asks `y/N`. Nothing is sent without the usual preview and approval, and nothing is offered while policy blocks escalation. Setting `aiPrivacyRouter.suggestEscalation` (`when-unsure` or `never`); terminal `/escalate suggest on|off`.
- **Reviews see the file's own tests:** when reviewing `Foo.java`, `foo.ts` or `foo.py`, the matching test (`FooTest.java`, `foo.test.ts`, `test_foo.py`, `foo_test.go`…) that calls its code is added as context.
- **Benchmark:** reports how often an escalation would be suggested on wrong vs. correct reviews.

## 1.0.13
- **`/escalate on|off` in VS Code chat:** turns cloud escalation on or off after a confirmation, saved to the open workspace (or User settings with no folder). Previously only the terminal understood it.
- **Clear reason when blocked:** a blocked `/escalate` names what blocks it (setting off, `mandatoryLocalOnly`, untrusted or remote workspace) and offers an **Open setting** button.
- **README:** how to turn escalation on, and the recommended per-workspace use.

## 1.0.12
- **Terminal `/review` on a folder:** `/review`, `/review all` or `/review <folder>` scan the whole folder (as `/scan`) instead of failing with "is not a file".
- **The chat knows where it is:** the local model is told the folder name and the Hushavyr commands. "Review this folder" gets "type /scan" instead of "I can't access your files".
- **The folder's own name works:** `/security MyProject`, typed from inside `MyProject`, scans the current folder.

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
