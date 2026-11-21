#!/usr/bin/env node
import {readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
const usage = 'Usage: node benchmarks/evaluate.mjs --results results.json [--min-precision 0.9 --min-recall 0.9]';
function option(name, fallback) { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i+1]; }
const resultFile = option('--results');
if (!resultFile) { console.error(usage); process.exit(2); }
const fixtures = JSON.parse(readFileSync(new URL('./fixtures.json', import.meta.url), 'utf8')).cases;
const results = JSON.parse(readFileSync(resolve(resultFile), 'utf8'));
if (!Array.isArray(results.cases)) throw new Error('Results must contain a cases array');
const byId = new Map();
for (const item of results.cases) {
  if (!item || typeof item.id !== 'string' || !Array.isArray(item.findings) ||
      item.findings.some(f => !f || typeof f.ruleId !== 'string')) throw new Error('Invalid case results');
  if (byId.has(item.id)) throw new Error('Duplicate case id: ' + item.id);
  byId.set(item.id, item.findings);
}
let tp=0,fp=0,fn=0; const perLanguage = {};
const details=[];
for (const fixture of fixtures) {
  if (!byId.has(fixture.id)) throw new Error('Missing case: ' + fixture.id);
  const found = byId.get(fixture.id);
  const expected = fixture.expected.map(x => x.toLowerCase());
  const matched = new Set();
  let localTp=0,localFp=0;
  for (const finding of found) {
    const rule = finding.ruleId.toLowerCase();
    const match = expected.findIndex((needle,i)=>!matched.has(i) && rule.includes(needle));
    if (match >= 0) {matched.add(match);localTp++;} else localFp++;
  }
  const localFn=expected.length-localTp;
  tp+=localTp;fp+=localFp;fn+=localFn;
  const lang=perLanguage[fixture.language]??={tp:0,fp:0,fn:0,cases:0};
  lang.tp+=localTp;lang.fp+=localFp;lang.fn+=localFn;lang.cases++;
  details.push({id:fixture.id,language:fixture.language,tp:localTp,fp:localFp,fn:localFn});
}
for (const id of byId.keys()) if (!fixtures.some(f=>f.id===id)) throw new Error('Unknown case: '+id);
const precision=tp+fp ? tp/(tp+fp) : (fn ? 0 : 1);
const recall=tp+fn ? tp/(tp+fn) : 1;
const minPrecision=Number(option('--min-precision','0'));
const minRecall=Number(option('--min-recall','0'));
if (![minPrecision,minRecall].every(x=>Number.isFinite(x)&&x>=0&&x<=1)) throw new Error('Invalid thresholds');
const report={schemaVersion:1,counts:{tp,fp,fn},precision,recall,perLanguage,details,passed:precision>=minPrecision&&recall>=minRecall};
console.log(JSON.stringify(report,null,2));
if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY,
  '## Hushavyr polyglot benchmark\n\nPrecision: '+(precision*100).toFixed(1)+'% · Recall: '+(recall*100).toFixed(1)+'%\n\n'+
  '| Language | TP | FP | FN |\n|---|---:|---:|---:|\n'+Object.entries(perLanguage).map(([l,s])=>`| ${l} | ${s.tp} | ${s.fp} | ${s.fn} |`).join('\n')+'\n',{flag:'a'});
if (!report.passed) process.exitCode=1;
