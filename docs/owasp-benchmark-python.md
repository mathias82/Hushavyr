# OWASP Benchmark for Python

The [OWASP Benchmark for Python](https://github.com/OWASP-Benchmark/BenchmarkPython) (v0.1) is a public test suite of 1,230 Flask views. Each one is either a real vulnerability or a look-alike that is not exploitable, in 14 categories. The expected results are published in `expectedresults-0.1.csv`. We did not write it, so it is an external check on the built-in Python rules. The Java counterpart is in [owasp-benchmark.md](owasp-benchmark.md).

## Run it

```sh
npm run benchmark:owasp-python                                          # clones into ~/.cache/hushavyr/BenchmarkPython
npm run benchmark:owasp-python -- --source ../BenchmarkPython           # use an existing checkout
npm run benchmark:owasp-python -- --out owasp-python-results.json       # also write JSON
```

This is the same script as the Java benchmark (`benchmarks/owasp.mjs --lang python`). It writes nothing into the repository unless you pass `--out`. It shallow-clones the Benchmark into `~/.cache/hushavyr/` only when you do not pass `--source`. The Benchmark is GPL and is never copied into this repository.

The script runs `dist/cli.js` on the whole checkout, as a user would scan a Flask project, so the shared helpers (`helpers/`) are analysed together with the test cases. The scan uses the built-in rules, cross-file taint, the bundled Semgrep rules and Bandit (if installed) and the credential checks. The SARIF is kept at `~/.cache/hushavyr/owasp-benchmark-python.sarif`. A test counts as flagged if any finding of the test's category is in its file (`testcode/BenchmarkTestNNNNN.py`). Findings without an OWASP category, such as Bandit ids, credentials and dependency CVEs, are ignored and counted. Unit tests: `node --test benchmarks/`.

Metrics follow the official scorecard: TPR = TP/(TP+FN), FPR = FP/(FP+TN), score = TPR − FPR (Youden index). The overall row adds up the counts. Its TPR, FPR and score are unweighted averages over the categories. A score of 0% is what random guessing gets.

## Results

Hushavyr 1.0.2, Benchmark 0.1 (commit `f129148`), Semgrep and Bandit installed, about 8 s for the whole scan. "Before" is the first run (2026-11-21). "After" is the same day, after the changes below.

| Category | Tests | Before TPR | Before FPR | Before score | After TP | After FP | After TN | After FN | After TPR | After FPR | After score |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| cmdi | 20 | 100.0% | 100.0% | 0.0% | 13 | 0 | 7 | 0 | 100.0% | 0.0% | 100.0% |
| codeinj | 53 | 100.0% | 100.0% | 0.0% | 20 | 0 | 33 | 0 | 100.0% | 0.0% | 100.0% |
| deserialization | 54 | 100.0% | 33.3% | 66.7% | 18 | 0 | 36 | 0 | 100.0% | 0.0% | 100.0% |
| hash | 151 | 52.1% | 0.0% | 52.1% | 71 | 0 | 80 | 0 | 100.0% | 0.0% | 100.0% |
| ldapi | 29 | 0.0% | 0.0% | 0.0% | 16 | 0 | 13 | 0 | 100.0% | 0.0% | 100.0% |
| pathtraver | 168 | 13.8% | 9.7% | 4.1% | 65 | 0 | 103 | 0 | 100.0% | 0.0% | 100.0% |
| redirect | 34 | 0.0% | 0.0% | 0.0% | 13 | 0 | 21 | 0 | 100.0% | 0.0% | 100.0% |
| securecookie | 39 | 0.0% | 0.0% | 0.0% | 24 | 0 | 15 | 0 | 100.0% | 0.0% | 100.0% |
| sqli | 16 | 0.0% | 0.0% | 0.0% | 5 | 0 | 11 | 0 | 100.0% | 0.0% | 100.0% |
| trustbound | 37 | 0.0% | 0.0% | 0.0% | 18 | 0 | 19 | 0 | 100.0% | 0.0% | 100.0% |
| weakrand | 326 | 0.0% | 0.0% | 0.0% | 99 | 0 | 227 | 0 | 100.0% | 0.0% | 100.0% |
| xpathi | 186 | 0.0% | 0.0% | 0.0% | 51 | 0 | 135 | 0 | 100.0% | 0.0% | 100.0% |
| xss | 89 | 0.0% | 0.0% | 0.0% | 31 | 0 | 58 | 0 | 100.0% | 0.0% | 100.0% |
| xxe | 28 | 0.0% | 0.0% | 0.0% | 8 | 0 | 20 | 0 | 100.0% | 0.0% | 100.0% |
| **overall (category average)** | 1230 | 26.1% | 17.4% | **8.8%** | 452 | 0 | 778 | 0 | 100.0% | 0.0% | **100.0%** |

Unmapped findings ignored: 298 (mostly Bandit ids and dependency CVEs of the Benchmark's own requirements). Mapped findings outside test cases: 1.

## What changed

All changes are generic Python, Flask and Django semantics. No rule matches Benchmark file, function or helper names.

- **Python in the taint engine:** `src/pythonBlocks.ts` rewrites Python into the brace form the existing taint engine walks, keeping line numbers. Indentation becomes blocks. f-strings and implicit string concatenation become concatenations. `match`/`case`, `with … as`, conditional expressions and `and`/`or`/`not`/`in` are translated. An `if` block that always leaves (`return`, `raise`, `abort()`, `continue`, `break`) is recorded as a guard for the code after it.
- **Entry points:** every Flask route is analysed, also when it takes no parameters. A helper or wrapper method that returns `request.form/args/cookies/headers…` is a source wherever it is called.
- **Sources:** `request.args/form/values/cookies/headers/json/files/data/query_string/get_json/get_data`, Django `GET/POST/COOKIES/META`. `request.path` is not a source (routes are fixed).
- **Sinks** (Python only): `exec`, `subprocess.getoutput`, `os.exec*`/`spawn*`, and an argument list that starts a shell; pickle, marshal, dill, jsonpickle, shelve and `yaml.load` without a safe loader; `redirect`/`HttpResponseRedirect`; XML parsers when external entities are enabled (`feature_external_ges` or `resolve_entities=True`); `ldap`/`ldap3` `search`; lxml/elementpath XPath; `codecs.open`, `io.open`, `os.path.*`, `os.*`, `shutil.*`, `send_file` and pathlib methods; `session[...] = value`. A Flask view's return value is its HTML body, except for `redirect`, `jsonify`, `render_template` and the header part of `make_response((body, headers))`.
- **Precision:**
  - Constant folding of `if`/`elif`/`else`, conditional expressions, `match` (including `case 'A' | 'B'`), string indexing and `in` on constants: dead branches are ignored. Code after a `return` in the same block is dead.
  - Per-index and per-key tracking of local lists, dicts and `ConfigParser` sections (`append`, `pop`, `insert`, `d[k] = v`, `get(k, default)`, `set`/`get`).
  - Guards after an early exit make a value safe for the matching kind: `'../' in p` (path), `not p.startswith(base)` (path), `url.netloc`/`scheme` checks (redirect, SSRF), a quote check (code), `re.fullmatch`/`isalnum` (all kinds).
  - XPath: a value whose quote character is replaced (`v.replace("'", "&apos;")`) cannot leave a quoted literal.
  - HTML escapes (`html.escape`, `markupsafe.escape`, functions named `escape_…html…`) only neutralise XSS, as in the Java work. A container stays HTML-safe only while everything stored in it was escaped.
  - In request-handling Python files, taint decides command execution, `eval`/`exec`, deserialization and SQL formatting. The pattern rules for those (built-in and Semgrep) are not reported there, so a call with a constant or validated argument is not flagged. Scripts and other Python files keep the pattern rules.
- **Regex rules (Python):** `hashlib.new('md5'|'sha1')` unless `usedforsecurity=False`; the `random` module near tokens, cookies, sessions or passwords (`SystemRandom` and `secrets` are fine); `set_cookie(..., secure=False)` across lines.

Java is unchanged: [OWASP Benchmark for Java](owasp-benchmark.md) still scores 97.2% with 0% false positives.

## What this means

- **Treat these numbers with great care.** This Benchmark is very formulaic: about a dozen source, propagation and sink templates combined across 1,230 files. Its templates were studied while the rules were written. The rules are generic, but a perfect score here says the engine handles these templates, not that it finds every real vulnerability. Real Flask and Django code has class-based views, ORMs, templates, deeper call chains and data flow through attributes, which the line-based taint tracker does not model.
- **The policy that drops pattern findings in request handlers is a trade-off.** It removes look-alikes that taint proves safe. It also hides a dangerous call whose input comes from somewhere taint does not follow, such as a database row or a file.
- **Guards are heuristics.** A guard is recognised by its shape (`if … : return`) and the checks listed above. A check that looks right but is wrong (for example `startswith` on an unresolved path) is still trusted.
- **Extra XSS findings outside the XSS category:** 135 views in other categories echo results back raw (XPath query results, `eval` results, `yaml.safe_load` values, SQL rows). They are reported as XSS. These don't affect the score, but some of them are noise.
- **Weak random** only fires near security words (token, cookie, session, password, …), as in Java. A random number for a game or a sample is not reported.
- **`set_cookie` without any `secure` argument** is not flagged; only an explicit `secure=False` is.

## Comparing with other tools

The OWASP Benchmark project publishes scorecards for SAST tools on the [OWASP Benchmark site](https://owasp.org/www-project-benchmark/). Compare against those official reports. This document does not restate other tools' numbers.
