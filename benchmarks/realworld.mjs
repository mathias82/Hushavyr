#!/usr/bin/env node
// Regression gate on six intentionally vulnerable apps, pinned to fixed commits (see docs/real-world-benchmarks.md).
// Only Hushavyr's built-in rules and data-flow tracking run, so the result does not depend on installed tools.
// The apps are cloned outside this repository; nothing from them is vendored.
//   node benchmarks/realworld.mjs            compare with benchmarks/realworld-baseline.json, exit 1 on any change
//   node benchmarks/realworld.mjs --update   accept the current findings as the new baseline
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export const APPS = [
  {name: 'juice-shop', url: 'https://github.com/juice-shop/juice-shop.git', commit: 'c9f99228d9d56afb5f5ca7925376292f7fa44b13'},
  {name: 'WebGoat', url: 'https://github.com/WebGoat/WebGoat.git', commit: '4e98f1cbbf896fdd06edcc9930515ebe0ade7c69'},
  {name: 'DVWA', url: 'https://github.com/digininja/DVWA.git', commit: '502ac150ce37c20ca6e04cab7c5ca959f315f2d0'},
  {name: 'railsgoat', url: 'https://github.com/OWASP/railsgoat.git', commit: 'f5951f13089d85c979de09e7da3c8c0fb982f94a'},
  {name: 'govwa', url: 'https://github.com/0c34/govwa.git', commit: '4058f79f31eeb4a36d8f1e64bba1f0c899646e6f'},
  {name: 'WebGoat.NET', url: 'https://github.com/jerryhoff/WebGoat.NET.git', commit: '1c6cab19f9029673cd98ba8624bf9cc91d04bae9'}
];

const git = (args, cwd) => spawnSync('git', args, {cwd, encoding: 'utf8'});

/** A checkout of app at its pinned commit under ~/.cache/hushavyr-bench (fetches only that commit). */
function checkout(app) {
  const dir = join(process.env.HUSHAVYR_BENCH_DIR ?? join(homedir(), '.cache', 'hushavyr-bench'), app.name);
  if (git(['rev-parse', 'HEAD'], dir).stdout?.trim() === app.commit) return dir;
  mkdirSync(dir, {recursive: true});
  if (!existsSync(join(dir, '.git'))) git(['init', '-q'], dir);
  for (const args of [['fetch', '-q', '--depth', '1', app.url, app.commit], ['checkout', '-q', '--force', app.commit]]) {
    const r = git(args, dir);
    if (r.status !== 0) throw new Error(`git ${args[0]} failed for ${app.name}: ${r.stderr}`);
  }
  return dir;
}

/** "ruleId path:line" for every finding; a set, so order and duplicates do not matter. */
export const keys = results => [...new Set(results.map(r => `${r.ruleId} ${r.path.split('\\').join('/')}:${r.line}`))].sort();

/** Findings that disappeared (lost) or appeared (added) per app. */
export function compare(baseline, current) {
  const diff = {};
  for (const [app, now] of Object.entries(current)) {
    const before = new Set(baseline[app] ?? []), after = new Set(now);
    const lost = [...before].filter(k => !after.has(k)), added = now.filter(k => !before.has(k));
    if (lost.length || added.length) diff[app] = {lost, added};
  }
  return diff;
}

async function main() {
  const repo = fileURLToPath(new URL('..', import.meta.url));
  const {scanFolder} = createRequire(import.meta.url)(join(repo, 'dist', 'cli.js'));
  const baselinePath = join(repo, 'benchmarks', 'realworld-baseline.json');
  const only = process.argv.includes('--app') ? process.argv[process.argv.indexOf('--app') + 1] : undefined;
  const current = {};
  for (const app of APPS.filter(a => !only || a.name === only)) {
    const results = await scanFolder(checkout(app), join(repo, 'rules', 'hushavyr-review.yml'), () => undefined, true);
    current[app.name] = keys(results);
    const taint = current[app.name].filter(k => k.startsWith('taint-')).length;
    console.log(`${app.name.padEnd(12)} ${String(current[app.name].length).padStart(4)} findings, ${String(taint).padStart(3)} data flows`);
  }
  const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : {};
  if (process.argv.includes('--update')) {
    writeFileSync(baselinePath, JSON.stringify({...baseline, ...current}, null, 1) + '\n');
    console.log('Baseline updated: ' + baselinePath);
    return;
  }
  const diff = compare(baseline, current);
  for (const [app, {lost, added}] of Object.entries(diff)) {
    console.log(`\n${app}: ${lost.length} lost, ${added.length} new`);
    for (const k of lost) console.log('  - ' + k);
    for (const k of added) console.log('  + ' + k);
  }
  if (Object.keys(diff).length) {
    console.log('\nFindings changed. Check each one: a lost true positive is a regression, a new false positive is noise.\nIf every change is an improvement, run: node benchmarks/realworld.mjs --update');
    process.exitCode = 1;
  } else console.log('\nNo change from the baseline.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch(error => { console.error(error.message); process.exitCode = 2; });
