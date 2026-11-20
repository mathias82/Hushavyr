# Hushavyr

**Local-first AI code review for VS Code.** Ask questions about your code and review selected or attached files with Ollama. The local review workflow covers Java, Python, TypeScript and JavaScript.

- **Review code locally.** Findings cite the relevant source lines so you can inspect the evidence.
- **Verify fixes locally.** Run Java/Maven, Python/pytest or native Node tests for JavaScript and TypeScript. Export a patch once the new regression test and the existing suite pass locally.
- **Use Copilot for public questions.** In optional hybrid mode, approve the exact message before sending it from an empty VS Code window.

## Quick start — install Ollama and Qwen from VS Code

1. Open **Extensions** (`Cmd+Shift+X` on macOS, `Ctrl+Shift+X` on Windows/Linux). Search for **Hushavyr - Private AI Code Review** by **Matthaios Stavrou**, or use the [official Marketplace listing](https://marketplace.visualstudio.com/items?itemName=mathias82.hushavyr). Click **Install**. Extension ID: `mathias82.hushavyr`.
2. Open the **Command Palette** with `Cmd+Shift+P` (Mac) or `Ctrl+Shift+P` (Windows/Linux), type **Hushavyr**, and select **Hushavyr: Install Ollama**. On macOS this offers a Homebrew installation if `brew` is available; otherwise it opens the official Ollama download page. Windows uses WinGet when available; Linux offers its installation script. Installation requires your confirmation.
3. In the Command Palette, run **Hushavyr: Start Ollama**. Confirm the terminal command if Ollama is not already running.
4. Run **Hushavyr: Download Local Qwen Model**. Confirm the download of `qwen2.5-coder:7b` (a multi-GB download); it is not downloaded automatically when you install the extension.
5. Run **Hushavyr: Ask Local Qwen** and enter a simple question to test the local connection. To review code, select a snippet and run **Hushavyr: Ask Local Qwen About Selection**.

> **Important:** Installing Hushavyr does **not** silently install Ollama, start a server, or download a model. Each setup command requires user action/confirmation. Ollama runs locally; if it is unavailable, Hushavyr does not silently send your code to a cloud provider. If commands are missing, run **Developer: Reload Window**, then search for `Hushavyr` again.

### Verify that the local Qwen model downloaded successfully

After **Hushavyr: Download Local Qwen Model**, the VS Code Terminal runs:

```bash
ollama pull qwen2.5-coder:7b
```

A successful download of the approximately 4.7 GB model ends with output similar to:

```text
pulling manifest
pulling ... 100%
verifying sha256 digest
writing manifest
success
```

The final **`success`** means the model files and manifest were downloaded and verified. To confirm the model is installed, run:

```bash
ollama list
```

Look for `qwen2.5-coder:7b` in the list. Next, run **Hushavyr: Start Ollama** if the local server is not already running, followed by **Hushavyr: Ask Local Qwen** to test a prompt. You can also test the model independently in the terminal with `ollama run qwen2.5-coder:7b`.

**If the download fails:** A `503` response containing an HTML **Access Denied** page may indicate a network proxy or organizational security filter rather than a corrupted model. Check the network connection and contact your IT administrator for an approved way to access the Ollama model registry. Do not bypass workplace security policies. Retry **Hushavyr: Download Local Qwen Model** once access is restored; Ollama can reuse already downloaded layers.

### Available Hushavyr commands

Open the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`) and type `Hushavyr` to find:

| Command | Purpose |
| --- | --- |
| **Hushavyr: Install Ollama** | Offer local Ollama installation or official download |
| **Hushavyr: Start Ollama** | Start the local Ollama server in a terminal |
| **Hushavyr: Download Local Qwen Model** | Download `qwen2.5-coder:7b` with confirmation |
| **Hushavyr: Ask Local Qwen** | Ask a typed question using the local model |
| **Hushavyr: Ask Local Qwen About Selection** | Ask about selected code locally |
| **Hushavyr: Classify Selection** | Preview privacy classification for selected text |
| **Hushavyr: Privacy Preview of Selection** | Inspect the selected content's privacy routing |
| **Hushavyr: Propose and Verify Local Fix** | Propose a code fix and run supported local verification |
| **Hushavyr: Review Cloud Override (No Transfer)** | Review-only cloud override; does not transfer content |
| **Hushavyr: Route Typed Prompt (Local by Default)** | Route a typed prompt according to configured policy |
| **Hushavyr: Run Existing Regression Tests** | Run a supported existing local test suite |

For supported languages, verification requirements, privacy limitations, and optional Copilot routing, read the [user guide](https://github.com/mathias82/Hushavyr/blob/main/docs/guide.md).

### Moving from the previous extension

If you previously installed `mathias82.ai-privacy-router` (also displayed as **Hushavyr**), install the new `mathias82.hushavyr` extension from the Marketplace. VS Code treats these as **different extensions**; updating the old extension does not install the new one. After checking the new installation and your settings, uninstall the old extension to avoid duplicate commands.

Hushavyr defaults to local-only and stops if Ollama is unavailable. Its routing rules apply only to requests initiated through Hushavyr; they do not control standalone Copilot or other extensions. For sensitive work, use a VS Code profile with standalone Copilot features disabled. Never test privacy with real secrets.

[User guide](https://github.com/mathias82/Hushavyr/blob/main/docs/guide.md) · [Marketplace](https://marketplace.visualstudio.com/items?itemName=mathias82.hushavyr) · [Releases](https://github.com/mathias82/Hushavyr/releases) · [Security policy](https://github.com/mathias82/Hushavyr/blob/main/SECURITY.md)
