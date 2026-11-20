# Hushavyr

**Local-first AI code review for VS Code.** Ask questions about your code and review selected or attached files with Ollama. The local review workflow covers Java, Python, TypeScript and JavaScript.

- **Review code locally.** Findings cite the relevant source lines so you can inspect the evidence.
- **Verify fixes locally.** Run Java/Maven, Python/pytest or native Node tests for JavaScript and TypeScript. Export a patch once the new regression test and the existing suite pass locally.
- **Use Copilot for public questions.** In optional hybrid mode, approve the exact message before sending it from an empty VS Code window.

## Quick start

1. In VS Code, open **Extensions** (`Cmd+Shift+X` on macOS, `Ctrl+Shift+X` on Windows/Linux). Search for **Hushavyr - Private AI Code Review** by **Matthaios Stavrou**, or open the [official Marketplace listing](https://marketplace.visualstudio.com/items?itemName=mathias82.hushavyr). Select **Install**. The extension ID is `mathias82.hushavyr`.
2. Open **Get started with Hushavyr** in VS Code. Follow the walkthrough to install Ollama if needed, start it, and download the local Qwen model. Model downloads require your consent.
3. Select a code snippet, open the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`), and run **Hushavyr: Ask Local Qwen About Selection**.
4. For a typed local prompt, run **Hushavyr: Ask Local Qwen**. For local code review and verified fixes, see the [user guide](https://github.com/mathias82/Hushavyr/blob/main/docs/guide.md).

### Moving from the previous extension

If you previously installed `mathias82.ai-privacy-router` (also displayed as **Hushavyr**), install the new `mathias82.hushavyr` extension from the Marketplace. VS Code treats these as **different extensions**; updating the old extension does not install the new one. After checking the new installation and your settings, uninstall the old extension to avoid duplicate commands.

Hushavyr defaults to local-only and stops if Ollama is unavailable. Its routing rules apply only to requests initiated through Hushavyr; they do not control standalone Copilot or other extensions. For sensitive work, use a VS Code profile with standalone Copilot features disabled. Never test privacy with real secrets.

[User guide](https://github.com/mathias82/Hushavyr/blob/main/docs/guide.md) · [Marketplace](https://marketplace.visualstudio.com/items?itemName=mathias82.hushavyr) · [Releases](https://github.com/mathias82/Hushavyr/releases) · [Security policy](https://github.com/mathias82/Hushavyr/blob/main/SECURITY.md)
