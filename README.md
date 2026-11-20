# Hushavyr

**Local-first AI code review for VS Code.** Ask questions about your code and review selected or attached files with Ollama. The local review workflow covers Java, Python, TypeScript and JavaScript.

- **Review code locally.** Findings cite the relevant source lines so you can inspect the evidence.
- **Verify Java/Maven and Python/pytest fixes.** Export a patch once the new regression test and the existing suite pass locally.
- **Use Copilot for public questions.** In optional hybrid mode, approve the exact message before sending it from an empty VS Code window.

## Quick start

1. Download the [v0.0.9 VSIX](https://github.com/mathias82/Hushavyr/releases/download/v0.0.9/hushavyr-0.0.9.vsix). In VS Code, open the Command Palette and run **Extensions: Install from VSIX…**.
2. Open **Get started with Hushavyr** in VS Code and follow the steps to install Ollama, start it, and download Qwen.
3. Select a code snippet and run **Hushavyr: Ask Local Qwen About Selection**.

Hushavyr defaults to local-only and stops if Ollama is unavailable. Its routing rules apply to requests it initiates. For sensitive work, use a VS Code profile with standalone Copilot features disabled.

[User guide](https://github.com/mathias82/Hushavyr/blob/main/docs/guide.md) · [Releases](https://github.com/mathias82/Hushavyr/releases) · [Security policy](https://github.com/mathias82/Hushavyr/blob/main/SECURITY.md)
