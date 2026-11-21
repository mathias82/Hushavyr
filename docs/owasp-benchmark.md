# OWASP Benchmark for Java

The [OWASP Benchmark for Java](https://github.com/OWASP-Benchmark/BenchmarkJava) (v1.2) is a public test suite of 2,740 servlets. Each one is either a real vulnerability or a look-alike that is not exploitable, in 11 categories. The expected results are published in `expectedresults-1.2.csv`. We did not write it, so it is an external check on the built-in rules. Our own fixtures in `benchmarks/fixtures.json` were written together with the rules.

## Run it

```sh
npm run benchmark:owasp                                   # clones into ~/.cache/hushavyr/BenchmarkJava
npm run benchmark:owasp -- --source ../BenchmarkJava      # use an existing checkout
npm run benchmark:owasp -- --out owasp-results.json       # also write JSON
```

`benchmarks/owasp.mjs` writes nothing into the repository unless you pass `--out`. It shallow-clones the Benchmark into `~/.cache/hushavyr/` only when you do not pass `--source`. The Benchmark is GPL-2 and is never copied into this repository. The script runs `dist/cli.js` on `src/main/java/org/owasp/benchmark/testcode`, so it uses the built-in rules, cross-file taint, the bundled Semgrep rules (if Semgrep is installed) and the credential checks. It reads the SARIF, maps rule ids to OWASP categories and scores each test file. A test counts as flagged if any finding of the test's category is in its file. Findings without an OWASP category, such as credentials and TLS, are ignored and counted. Unit tests: `node --test benchmarks/`.

Metrics follow the official scorecard: TPR = TP/(TP+FN), FPR = FP/(FP+TN), score = TPR − FPR (Youden index). The overall row adds up the counts. Its TPR, FPR and score are unweighted averages over the categories, as on the scorecard. A score of 0% is what random guessing gets.

## Results

Hushavyr 0.0.32, Benchmark 1.2 (commit `10dfcc5`), Semgrep installed. "Before" is the first run (2026-11-21, about 13 s scan). "After" is the same day, after the rule and taint changes below.

| Category | Tests | Before TPR | Before FPR | Before score | After TP | After FP | After TN | After FN | After TPR | After FPR | After score |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| cmdi | 251 | 0.0% | 0.0% | 0.0% | 126 | 0 | 125 | 0 | 100.0% | 0.0% | 100.0% |
| crypto | 246 | 0.0% | 0.0% | 0.0% | 130 | 0 | 116 | 0 | 100.0% | 0.0% | 100.0% |
| hash | 236 | 21.7% | 0.0% | 21.7% | 89 | 0 | 107 | 40 | 69.0% | 0.0% | 69.0% |
| ldapi | 59 | 0.0% | 0.0% | 0.0% | 27 | 0 | 32 | 0 | 100.0% | 0.0% | 100.0% |
| pathtraver | 268 | 1.5% | 1.5% | 0.0% | 133 | 0 | 135 | 0 | 100.0% | 0.0% | 100.0% |
| securecookie | 67 | 100.0% | 0.0% | 100.0% | 36 | 0 | 31 | 0 | 100.0% | 0.0% | 100.0% |
| sqli | 504 | 19.1% | 21.6% | -2.4% | 272 | 0 | 232 | 0 | 100.0% | 0.0% | 100.0% |
| trustbound | 126 | 0.0% | 0.0% | 0.0% | 83 | 0 | 43 | 0 | 100.0% | 0.0% | 100.0% |
| weakrand | 493 | 0.0% | 0.0% | 0.0% | 218 | 0 | 275 | 0 | 100.0% | 0.0% | 100.0% |
| xpathi | 35 | 0.0% | 0.0% | 0.0% | 15 | 0 | 20 | 0 | 100.0% | 0.0% | 100.0% |
| xss | 455 | 0.0% | 0.0% | 0.0% | 246 | 0 | 209 | 0 | 100.0% | 0.0% | 100.0% |
| **overall (category average)** | 2740 | 12.9% | 2.1% | **10.8%** | 1375 | 0 | 1325 | 40 | 97.2% | 0.0% | **97.2%** |

Unmapped findings ignored: 0.

## What changed

All changes are generic Java/Servlet/Spring semantics. No rule matches Benchmark file, class or helper names.

- **Sources:** parameter values, maps and names; headers and header names; cookies; the query string; and request-wrapper getters named like `get…Parameter`, `get…Header` or `get…Cookie`. Servlet init parameters are trusted. A for-each loop variable inherits taint from its collection.
- **Sinks** (Java only):
  - SQL: `prepareCall`, `addBatch`, `batchUpdate`, and JdbcTemplate `query*`.
  - Commands: `exec`, `ProcessBuilder` and `command`.
  - Files: `File`, file streams, readers and writers, `Paths.get` and `Path.of`.
  - XSS: `getWriter()` or `getOutputStream()` output, including through a writer variable.
  - LDAP: `search` on a `DirContext`.
  - XPath: `evaluate` and `compile`.
  - Trust boundary: session `setAttribute` and `putValue`.
- **Precision:**
  - Constant folding of `if`/`else`, ternaries and `switch` on a constant: dead branches are ignored.
  - Per-index and per-key tracking of locally created lists and maps (`add`, `put`, `remove(n)`, `get`).
  - Return summaries, so a helper that returns a constant no longer taints its result.
  - Multi-line call expressions are no longer mistaken for method definitions.
- **Kind-aware encoders:** HTML encoders (`escapeHtml`, `htmlEscape`, `encodeForHTML`, …) only neutralise XSS. Escaped input that reaches SQL, a command, a path or the session is still reported.
- **Regex rules:**
  - The name-based SQL concatenation rule for Java/JS/TS/Python was dropped; it produced false positives on constant data. SQL injection now comes from taint.
  - New rules: weak ciphers (DES, 3DES, RC2, RC4, Blowfish, ECB mode in `Cipher`, `KeyGenerator` or `SecretKeyFactory`), `java.util.Random`/`Math.random`, and SHA-1 with a provider argument.

## What this means

- **Treat these numbers with care.** The Benchmark is formulaic: a small set of source, propagation and sink templates combined across 2,740 files. Its patterns were studied while the rules were tuned. The rules are generic, but a near-perfect score here does not mean near-perfect detection on real code. Real projects have deeper call chains, frameworks, reflection and data flow through fields, and the line-based taint tracker does not model these.
- **hash (69%):** the 40 misses read the algorithm name from `benchmark.properties` (`getProperty("hashAlg1", …)`). That file is outside the scanned folder. The in-code default is misleading (for example `SHA512` where the real value is MD5), so defaults are deliberately not trusted.
- **Bare `"AES"`** is not flagged. The JDK defaults it to ECB, but the Benchmark labels it safe, and flagging it would add noise.
- **The taint analysis is line-based and heuristic.** Calls into code outside the scan stay conservative: a tainted argument taints the result unless the method is summarised.

## Comparing with other tools

The OWASP Benchmark project publishes scorecards for open-source and commercial SAST tools on the [OWASP Benchmark site](https://owasp.org/www-project-benchmark/). Compare against those official reports. This document does not restate other tools' numbers.
