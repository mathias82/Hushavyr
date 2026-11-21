#!/usr/bin/env node
// Offline provider dashboard; no network requests or source-code embedding.
import {readFileSync,writeFileSync} from 'node:fs';
const args=process.argv.slice(2),input=args[args.indexOf('--report')+1],out=args[args.indexOf('--out')+1];
if(!input||!out)throw Error('Usage: node benchmarks/provider-dashboard.mjs --report scored.json --out dashboard.html');
const report=JSON.parse(readFileSync(input,'utf8'));
if(!Array.isArray(report.providers))throw Error('Invalid scored provider report');
const esc=x=>String(x).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pct=n=>typeof n==='number'?(n*100).toFixed(1)+'%':'n/a';
const rows=report.providers.map(p=>'<tr><td>'+esc(p.name)+'</td><td>'+pct(p.precision)+'</td><td>'+pct(p.recall)+'</td><td>'+esc(p.totals?.falsePositive??p.totals?.falsePositives??'n/a')+'</td><td>'+esc(p.totals?.falseNegative??p.totals?.falseNegatives??'n/a')+'</td><td>'+esc(p.totals?.invalidResponses??'n/a')+'</td></tr>').join('');
writeFileSync(out,'<!doctype html><html lang="en"><meta charset="utf-8"><title>Hushavyr AI provider comparison</title><style>body{font:16px system-ui;max-width:900px;margin:3rem auto;background:#101820;color:#e9f0f4}table{width:100%;border-collapse:collapse}th,td{padding:1rem;border-bottom:1px solid #58616a;text-align:left}</style><h1>AI review provider comparison</h1><p>Synthetic fixtures; measured model responses only. Provider/model identity is user-reported. No token or cost claims.</p><table><tr><th>Provider/model</th><th>Precision</th><th>Recall</th><th>False positives</th><th>False negatives</th><th>Invalid responses</th></tr>'+rows+'</table></html>');
console.log(out);
