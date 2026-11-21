#!/usr/bin/env node
// External benchmark: scores the Hushavyr CLI against the OWASP Benchmark for Java (v1.2).
// The OWASP project is GPL-2 and is cloned outside this repository; nothing from it is vendored.
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export const CATEGORIES = ['cmdi', 'crypto', 'hash', 'ldapi', 'pathtraver', 'securecookie', 'sqli', 'trustbound', 'weakrand', 'xpathi', 'xss'];
// Rule ids as they appear in our SARIF (built-in, taint-*, canonical Semgrep ids); CWE ids are accepted too.
const RULES = [
  ['cmdi', /command-execution|runtime-exec|shell-execution|child-process-exec|^taint-command$|cwe-0*78$/],
  ['crypto', /weak-cipher|weak-encryption|cwe-0*327$/],
  ['hash', /weak-(?:cryptographic-)?hash|cwe-0*328$/],
  ['ldapi', /ldap|cwe-0*90$/],
  ['pathtraver', /path-traversal|^taint-path$|cwe-0*22$/],
  ['securecookie', /cookie-insecure|insecure-cookie|cwe-0*614$/],
  ['sqli', /sql|cwe-0*89$/],
  ['trustbound', /trust-boundary|cwe-0*501$/],
  ['weakrand', /(?:weak|insecure)-random|cwe-0*330$/],
  ['xpathi', /xpath|cwe-0*643$/],
  ['xss', /xss|cwe-0*79$/]
];

/** OWASP category for one of our rule ids, or undefined when it has no Benchmark counterpart. */
export const categoryOf = ruleId => RULES.find(([, rx]) => rx.test(String(ruleId).toLowerCase()))?.[0];

/** Parses expectedresults-1.2.csv: "test name, category, real vulnerability, cwe". */
export function parseExpected(csv) {
  return csv.split(/\r?\n/).filter(l => l.trim() && !l.startsWith('#')).map(l => {
    const [test, category, real, cwe] = l.split(',').map(s => s.trim());
    return {test, category, real: real === 'true', cwe: Number(cwe)};
  });
}

/** Maps SARIF results to test name -> set of OWASP categories flagged in that file. */
export function flaggedTests(sarif) {
  const flagged = new Map();
  let unmapped = 0, outside = 0;
  for (const run of sarif.runs ?? []) for (const r of run.results ?? []) {
    const uri = r.locations?.[0]?.physicalLocation?.artifactLocation?.uri ?? '';
    const test = /(BenchmarkTest\d{5})\.java$/.exec(uri)?.[1];
    const category = categoryOf(r.ruleId);
    if (!category) { unmapped++; continue; }
    if (!test) { outside++; continue; }
    if (!flagged.has(test)) flagged.set(test, new Set());
    flagged.get(test).add(category);
  }
  return {flagged, unmapped, outside};
}

const rates = c => {
  const tpr = c.tp + c.fn ? c.tp / (c.tp + c.fn) : 0, fpr = c.fp + c.tn ? c.fp / (c.fp + c.tn) : 0;
  return {...c, tpr, fpr, score: tpr - fpr};
};

/** Per-category confusion matrix plus the official-style overall score (unweighted average over categories). */
export function score(expected, flagged) {
  const per = {};
  for (const e of expected) {
    const c = per[e.category] ??= {tests: 0, tp: 0, fp: 0, tn: 0, fn: 0};
    const hit = flagged.get(e.test)?.has(e.category) ?? false;
    c.tests++;
    c[e.real ? (hit ? 'tp' : 'fn') : (hit ? 'fp' : 'tn')]++;
  }
  const categories = Object.fromEntries(Object.keys(per).sort().map(k => [k, rates(per[k])]));
  const list = Object.values(categories), avg = k => list.length ? list.reduce((s, c) => s + c[k], 0) / list.length : 0;
  const sum = k => list.reduce((s, c) => s + c[k], 0);
  const overall = {tests: sum('tests'), tp: sum('tp'), fp: sum('fp'), tn: sum('tn'), fn: sum('fn'), tpr: avg('tpr'), fpr: avg('fpr'), score: avg('score')};
  return {categories, overall};
}

const pct = x => (x * 100).toFixed(1) + '%';
export function markdown({categories, overall}) {
  const row = (name, c) => `| ${name} | ${c.tests} | ${c.tp} | ${c.fp} | ${c.tn} | ${c.fn} | ${pct(c.tpr)} | ${pct(c.fpr)} | ${pct(c.score)} |`;
  return ['| Category | Tests | TP | FP | TN | FN | TPR | FPR | Score |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...Object.entries(categories).map(([k, c]) => row(k, c)), row('**overall (category average)**', overall)].join('\n');
}

function option(name) { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; }

function checkout(source) {
  if (source) return resolve(source);
  const dir = join(homedir(), '.cache', 'hushavyr', 'BenchmarkJava');
  if (!existsSync(dir)) {
    mkdirSync(join(dir, '..'), {recursive: true});
    const git = spawnSync('git', ['clone', '--depth', '1', 'https://github.com/OWASP-Benchmark/BenchmarkJava.git', dir], {stdio: 'inherit'});
    if (git.status !== 0) throw new Error('git clone failed');
  }
  return dir;
}

function main() {
  const repo = fileURLToPath(new URL('..', import.meta.url));
  const source = checkout(option('--source'));
  const testcode = join(source, 'src/main/java/org/owasp/benchmark/testcode');
  const sarifPath = join(homedir(), '.cache', 'hushavyr', 'owasp-benchmark.sarif');
  mkdirSync(join(sarifPath, '..'), {recursive: true});
  const scan = spawnSync(process.execPath, [join(repo, 'dist/cli.js'), testcode, '--sarif', sarifPath, '--fail-on', 'none'], {encoding: 'utf8', maxBuffer: 1 << 28});
  if (scan.status !== 0) throw new Error('scan failed: ' + scan.stderr);
  const csv = readFileSync(join(source, 'expectedresults-1.2.csv'), 'utf8');
  const {flagged, unmapped, outside} = flaggedTests(JSON.parse(readFileSync(sarifPath, 'utf8')));
  const result = score(parseExpected(csv), flagged);
  const commit = spawnSync('git', ['-C', source, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).stdout?.trim();
  const version = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version;
  const report = {benchmark: 'OWASP Benchmark for Java 1.2', commit, hushavyr: version, date: new Date().toISOString().slice(0, 10), unmappedFindings: unmapped, findingsOutsideTests: outside, ...result};
  if (option('--out')) writeFileSync(resolve(option('--out')), JSON.stringify(report, null, 2) + '\n');
  console.log(`OWASP Benchmark 1.2 (${commit?.slice(0, 7)}), Hushavyr ${version}, ${report.date}\n\n${markdown(result)}\n\nUnmapped findings ignored: ${unmapped}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 2; }
}
