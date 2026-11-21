# Real-world check: OWASP Juice Shop

Benchmarks are clean; real repositories are noisy. This page records what the Hushavyr CLI scan (built-in rules only, no AI model, nothing leaves the machine) reports on [OWASP Juice Shop](https://github.com/juice-shop/juice-shop), a real Node.js/Angular application that is vulnerable on purpose, and which findings are noise.

- Juice Shop commit: `c9f9922` (shallow clone, November 2026)
- Command: `node dist/cli.js juice-shop --sarif juice-shop.sarif --fail-on none`
- Time: about 11 seconds on a laptop, about 660 TypeScript files

## Result

| | Before tuning | After tuning |
| --- | ---: | ---: |
| Findings | 230 | 166 |
| `error` (HIGH) | 220 | 35 |
| `warning` (MEDIUM) | 10 | 131 |
| False positives at HIGH | 65 | 1 |

What changed after the first run:

- **Translations:** 65 strings such as `"LABEL_PASSWORD": "パスワード"` in `frontend/src/assets/i18n/*.json` were reported as credentials. Values written in a non-Latin script are now treated as labels.
- **Tests:** 121 passwords in `test/`, `*.spec.ts` and Cypress files were HIGH in the CLI. They are now MEDIUM (`warning`), as in the editor, so real configuration stands out.

## HIGH findings (35)

| Finding | Count | Verdict |
| --- | ---: | --- |
| SQL injection, `routes/login.ts`, `routes/search.ts` | 2 | Real (known challenges) |
| SQL injection in `data/static/codefixes/*` | 11 | Real vulnerable code; these are the challenge "wrong answers" |
| Code injection via `eval`, `routes/userProfile.ts` | 1 | Real (SSTI challenge) |
| Seeded user passwords, `data/static/users.yml` | 18 | Real hardcoded credentials (demo users) |
| Hardcoded RSA private key, `lib/insecurity.ts` | 1 | Real (JWT forging challenge) |
| `testingPassword`, `login.component.ts` | 1 | Real hardcoded password |
| Klingon translation `"mu'wIj"`, `tlh_AA.json` | 1 | False positive |

## MEDIUM findings worth a look

SSRF in `routes/profileImageUrlUpload.ts`, path traversal in `routes/vulnCodeSnippet.ts` and `vulnCodeFixes.ts`, MD5 in `lib/insecurity.ts`, `innerHTML` in the hacking instructor. Noise: `eval` of a server-generated captcha sum, MD5 used as a file checksum in `scripts/package.mjs`, `innerHTML` in the vendored `three.js`, and test passwords.

## Known misses

The built-in rules do not catch these Juice Shop vulnerabilities yet. Semgrep, the local AI review (`/review`, `/scan`) or a manual check are needed:

- NoSQL injection through MongoDB `$where` (`routes/trackOrder.ts`, `routes/showProductReviews.ts`)
- XSS through Angular `bypassSecurityTrustHtml`
- Insecure deserialization through `vm` sandboxes (`routes/b2bOrder.ts`)
- XXE in XML upload, Zip Slip in ZIP upload
- Open redirect allow-list bypass (`routes/redirect.ts`)

No tool is perfect; findings are potential issues and need checking before acting.
