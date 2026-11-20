# Live privacy and routing smoke test

Use a disposable VS Code profile and synthetic data. Record the Hushavyr, VS Code, Ollama and Copilot versions, plus the result of each case. Keep any network captures local and omit account data from shared results.

## Sensitive profile

Create a separate profile and disable the Copilot extensions in it. Apply the [local-only profile settings](../profiles/local-only.settings.json) and restart the extension host. Confirm in the Extensions view that the Copilot extensions are disabled in that profile. Confirm that ordinary Copilot Chat and inline suggestions are unavailable.

Start Ollama with a locally installed model and apply the [local-only Ollama settings](../profiles/ollama-server.local-only.json). Use unique synthetic markers in a prompt, a filename and the file contents.

| Case | Expected result |
| --- | --- |
| Run **Hushavyr: Ask Local Qwen About Selection** on the synthetic file | Local answer. The relevant source is sent to the loopback Ollama server. |
| Run **Hushavyr: Route Typed Prompt (Local by Default)** with a synthetic credential such as `api_key=synthetic-canary` | Local answer. No Copilot model picker or cloud request. |
| Stop Ollama and repeat | A local error and no cloud fallback. |
| Type in the editor while ordinary Copilot is disabled | No Copilot suggestions or Chat. |

For a network-level check, observe connections from the VS Code extension host, Copilot processes if present, and the Ollama daemon during each action. Record the destination and whether access to provider endpoints was observed. Encrypted traffic can identify connection activity but cannot establish payload contents. A UI observation alone is insufficient for a network-level result.

## Public-prompt profile

Use a separate trusted, empty VS Code window with Copilot enabled. Enable the application setting `aiPrivacyRouter.routingMode` with value `hybrid-public-prompts`. Use only a public synthetic prompt such as “Design a Java queue and compare two implementations.”

| Case | Expected result |
| --- | --- |
| Run the routing command and dismiss the exact-payload approval | No model request is sent. Model discovery may already have occurred. |
| Rerun and approve the exact preview | One Copilot model request and an answer. The preview contains the typed public prompt and a fixed instruction. |
| Open a project or file and rerun the routing command | Local routing and no Copilot discovery for the request. |

The automated adapter test checks the exact message passed to the Copilot API and uses a real loopback HTTP server for the Ollama leg. The Copilot API in that test is simulated. The live smoke test checks the installed extension and profile behavior.
