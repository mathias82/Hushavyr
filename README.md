# Hushavyr — Private AI Code Review

Code review and security checks in VS Code that run **on your machine** with Ollama. Your code does not go to a cloud model.

## Why Hushavyr?

**Hushavyr** is a coined name built around **“hush”** — the idea of keeping something quiet, confidential, and protected. **“-avyr”** is a distinctive invented ending, not a word with an established dictionary meaning.

The name expresses the project's privacy-first philosophy: review and improve code locally, keep sensitive information under your control, and require explicit approval before sharing anything externally.

> **Private AI. Verified Code.**  
> *Your code stays yours.*

This is a brand interpretation, not a literal translation of an existing word.

## Install

1. Install **Hushavyr** from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=mathias82.hushavyr).
2. Run **Hushavyr: Setup** from the Command Palette. It installs or downloads Ollama, a local model and, if you agree, Semgrep, Gitleaks and Trivy. Nothing is installed without asking you.
3. Open a project and type `@ai-privacy /review` in Chat.

## Commands

Type `@ai-privacy` in VS Code Chat, then one of these commands:

| Command | What it does |
| --- | --- |
| `/review` | Finds bugs and security issues in the open file, and checks your team rules |
| `/explain` | Explains the open or selected code |
| `/edit` | Changes the open or selected code with the local model. Follow-ups like *"can you add them"* after `/explain` also work. You see a diff and nothing changes until you click **Apply**. You can also **Try another local model** or **Escalate** (opt-in, names removed). |
| `/pr` | Commits your changes to a new branch, pushes it and opens a pull request (`gh`, or a GitHub link). Asks first and stops if it finds credentials. |
| `/review-changes` | Reviews your uncommitted changes |
| `/scan` | Reviews the whole project: AI, Semgrep, Gitleaks, built-in rules, data flow and CVEs |
| `/scan-changed` | Same as `/scan`, but only for files that changed since the last scan |
| `/security` | Fast project security scan without AI: rules, credentials, and request input that reaches SQL, shell, eval, files or URLs |
| `/secrets` · `/gitleaks` | Finds hardcoded passwords and keys (values are hidden) |
| `/dependencies` | Finds CVEs with Trivy and shows whether your code calls the vulnerable function |
| `/test` | Runs the project tests |
| `/auto` | Sends a typed question that contains no code to the right model |
| `/escalate` | *Opt-in.* Sends only the selected function to a Copilot model, with names removed and after you approve it (see below) |

Quick fixes on findings:
- **Propose a local fix:** shows a diff, and nothing changes until you approve it.
- **Prove with a failing test:** runs a generated test in an offline Docker container. The bug counts as confirmed only if that test fails.
- **Not a real issue:** hides the finding for the whole team.

## Team files (commit them)

| File | Purpose |
| --- | --- |
| `.hushavyr/rules.md` | Your team standards, e.g. "never log tokens". `/review` checks the code against them. |
| `.hushavyr/dismissed.json` | False positives hidden for everyone. Created by the *Not a real issue* quick fix. |
| `.hushavyr/ignore` | Paths that are never scanned, one per line (`src/test/`, `*.gen.ts`). Use it for intentionally vulnerable test fixtures. |

## CI

- **Project scan:** run `node dist/cli.js . --sarif hushavyr.sarif --fail-on high` and upload the SARIF to GitHub code scanning. See `.github/workflows/hushavyr-scan.yml`.
- **PR review:** copy `examples/hushavyr-pr-review.yml` into your workflows. It runs on a self-hosted runner with Ollama, reviews only the changed lines and comments on the PR.

## Privacy

- Review and scanning run only on your machine. There is no automatic cloud fallback.
- `/escalate` is off unless you turn on `aiPrivacyRouter.cloudEscalation`. When it is on:
  - It sends only the selection, up to 4,000 characters.
  - Names, strings and comments are replaced with tokens such as `id1` or `s1`. The mapping stays on your machine.
  - It is blocked for secrets, personal data, `.env`/key files, ignored files and local-only workspaces.
  - You see the exact text before anything is sent, and every send is written to a local audit log.
  - The answer is a suggestion: verify it locally.
- Findings are potential issues. Check them before acting.

More details are in the [user guide](docs/guide.md).

**Author:** Matthaios Stavrou · [GitHub](https://github.com/mathias82/Hushavyr)
