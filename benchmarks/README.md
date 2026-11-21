# Hushavyr multilingual benchmark (v1)

This benchmark defines **12 source-level fixtures across 8 languages**: Java, Python, JavaScript, TypeScript, Go, PHP, Ruby and C#. It includes vulnerable examples and clean negative controls. These are *synthetic fixtures*, not evidence of real-world precision.

## Scoring contract

The evaluator accepts a JSON file with the shape:

```json
{"cases":[{"id":"js-eval","findings":[{"ruleId":"eval"}]}]}
```

Every case in `fixtures.json` must be present exactly once. Each expected substring matches at most one finding's `ruleId` (case insensitive). Extra findings count as false positives; unmatched expected IDs count as false negatives. Metrics: precision = TP/(TP+FP), recall = TP/(TP+FN). Empty clean cases are valid.

Run evaluator tests:

```sh
node --test benchmarks/evaluate.test.mjs
```

Evaluate captured scanner output:

```sh
node benchmarks/evaluate.mjs --results benchmarks/results.json --min-precision 0.9 --min-recall 0.9
```

**Important:** The current PR introduces the fixture catalog, deterministic scoring and CI tests for the scorer. It **does not yet connect Hushavyr's real CLI or Ollama to the fixtures**. No measured detection accuracy or privacy compliance is claimed. A follow-up integration runner must materialize each fixture in a temporary isolated workspace, invoke the real scanner, normalize SARIF rule IDs, and save results with scanner/model/version metadata. Calibrate rule IDs against actual findings before enabling quality thresholds. Add dependency, cross-file, and regression-fix scenarios separately; do not claim those capabilities are measured by this benchmark.

Never run deliberately vulnerable fixtures as programs. Do not include actual credentials or private code.
