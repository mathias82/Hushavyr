# Hushavyr

Hushavyr is a local-first AI extension for VS Code, formerly called AI Privacy Router.

- Ask Ollama about code and review selected or attached files locally, including Java, Python, TypeScript and JavaScript.
- Optionally send an explicitly approved public prompt to GitHub Copilot from an empty VS Code window.
- Propose and test Java/Maven fixes locally, and export a patch when the regression and existing tests pass.

Local-only is the default. Hushavyr controls the requests it initiates. For sensitive work, disable independent Copilot features in your VS Code profile.

## Install

1. Install [Ollama](https://ollama.com/download) on the machine running the VS Code extension host. Start it and run `ollama pull qwen2.5-coder:7b`.
2. Download `ai-privacy-router-0.0.7.vsix` from the [Hushavyr v0.0.7 preview release](https://github.com/mathias82/ai-privacy-router/releases/tag/v0.0.7).
3. In VS Code, choose **Extensions: Install from VSIX…** from the Command Palette and select the file.
4. Select some sample code and run **Hushavyr: Ask Local Qwen About Selection**.

[User guide](https://github.com/mathias82/ai-privacy-router/blob/main/docs/guide.md) · [Security policy](https://github.com/mathias82/ai-privacy-router/blob/main/SECURITY.md)
