#!/usr/bin/env node
// Offline HTML dashboard. Reads benchmark artifacts; no network requests.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
const args=process.argv.slice(2),value=(key,fallback)=>{const i=args.indexOf(key);return i>=0?args[i+1]:fallback};
const input=value('--results','benchmarks/results.json'),output=resolve(value('--out','benchmarks/dashboard.html'));
const files=[input,...args.filter((x,i)=>args[i-1]==='--compare')];
const fixture=JSON.parse(readFileSync(new URL('./fixtures.json',import.meta.url),'utf8')).cases;
const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function score(data){
 if(!Array.isArray(data.cases))throw Error('Missing cases');
 const found=new Map(data.cases.map(c=>[c.id,c]));
 let tp=0,fp=0,fn=0,duration=0;const languages={};
 for(const f of fixture){
  const c=found.get(f.id);if(!c)throw Error('Missing case '+f.id);
  const expected=f.expected.map(s=>s.toLowerCase()),seen=new Set();
  const lang=languages[f.language]??={tp:0,fp:0,fn:0,cases:0,durationMs:0};
  lang.cases++;lang.durationMs+=Number(c.durationMs||0);duration+=Number(c.durationMs||0);
  for(const finding of c.findings){
   const id=String(finding.ruleId||'').toLowerCase();
   const index=expected.findIndex((s,i)=>!seen.has(i)&&id.includes(s));
   if(index<0){fp++;lang.fp++}else{tp++;lang.tp++;seen.add(index)}
  }
  fn+=expected.length-seen.size;lang.fn+=expected.length-seen.size;
 }
 return {tp,fp,fn,precision:tp+fp?tp/(tp+fp):fn?0:1,recall:tp+fn?tp/(tp+fn):1,duration,languages};
}
const runs=files.map(file=>{const data=JSON.parse(readFileSync(resolve(file),'utf8'));return {label:data.version||data.commit||file,score:score(data)}});
const percent=n=>(100*n).toFixed(1)+'%';
const rows=runs.map(({label,score:s})=>`<tr><td>${escape(label)}</td><td>${percent(s.precision)}</td><td>${percent(s.recall)}</td><td>${s.fp}</td><td>${s.fn}</td><td>${s.duration} ms</td></tr>`).join('');
const detail=Object.entries(runs[0].score.languages).map(([lang,s])=>`<tr><td>${escape(lang)}</td><td>${s.cases}</td><td>${s.tp}</td><td>${s.fp}</td><td>${s.fn}</td><td>${s.durationMs} ms</td></tr>`).join('');
const html=`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Hushavyr benchmark dashboard</title><style>body{font:16px system-ui;margin:3rem auto;max-width:1100px;padding:0 1rem;background:#101820;color:#e7edf2}h1{color:#b8e8db}table{width:100%;border-collapse:collapse;margin:1rem 0 2rem}td,th{padding:.8rem;border-bottom:1px solid #45515b;text-align:left}th{color:#b8e8db}small{color:#b0bdc7}</style><h1>Hushavyr · Polyglot benchmark</h1><small>Measured static CLI results from supplied JSON artifacts. Synthetic fixtures, not production accuracy.</small><h2>Version comparison</h2><table><thead><tr><th>Run / version</th><th>Precision</th><th>Recall</th><th>False positives</th><th>Missed findings</th><th>Total time</th></tr></thead><tbody>${rows}</tbody></table><h2>Per-language breakdown · ${escape(runs[0].label)}</h2><table><thead><tr><th>Language</th><th>Cases</th><th>TP</th><th>FP</th><th>FN</th><th>Time</th></tr></thead><tbody>${detail}</tbody></table></html>`;
mkdirSync(dirname(output),{recursive:true});writeFileSync(output,html);console.log('Dashboard: '+output);
