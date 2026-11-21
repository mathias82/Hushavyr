# Stability and versioning

Hushavyr follows [Semantic Versioning](https://semver.org). From 1.0.0 the public surface below is stable. A breaking change to it needs a new major version.

## Stable public surface

| Surface | What is stable |
|---|---|
| Chat participant | The id `ai-privacy-router.privacy`, the handle `@ai-privacy`, and its slash commands: `/review`, `/explain`, `/edit`, `/improve`, `/review-changes`, `/test`, `/auto`, `/scan`, `/scan-changed`, `/secrets`, `/security`, `/gitleaks`, `/dependencies`, `/escalate`, `/pr` |
| Commands | Every `aiPrivacyRouter.*` command id in `package.json` (`contributes.commands`) |
| Settings | Every `aiPrivacyRouter.*` setting key, its type and its default behaviour |
| CLI | `hushavyr-scan [folder] [--sarif <file>] [--fail-on high\|medium\|none]` and `hushavyr-review`. Exit code `0` means no finding at or above the threshold, `1` means there are failing findings, `2` means the scan could not run |
| SARIF | SARIF 2.1.0 output. The existing `ruleId` values and the `level` mapping stay the same, and new rules only add ids |
| Team files | The formats of `.hushavyr/rules.md`, `.hushavyr/dismissed.json` and `.hushavyr/ignore` |
| Proof receipts | The `policyVersion` values (`maven-`, `pytest-`, `node-`, `typescript-`, `go-red-green-v1`). A stricter policy gets a new version string and does not change an old one |

## Not covered

These can change in any minor release:

- the text of review findings, prompts and chat answers;
- which findings a rule reports (rules are tuned on benchmarks);
- default model suggestions;
- benchmark numbers;
- internal modules under `src/`.

## Deprecation

A stable command, setting or CLI flag is marked deprecated in the CHANGELOG and in its description for at least one minor release, and it keeps working during that release. It is removed only in the next major release.

## Privacy guarantees

These are not part of the versioned API. They never change in any version:

- no telemetry;
- no automatic cloud fallback;
- no code or file names leave the machine unless you confirm a specific action.

**Report an Issue** shows the redacted text first, and sends nothing until you open the issue page yourself.
