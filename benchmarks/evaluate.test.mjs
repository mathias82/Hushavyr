import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
const fixtures=JSON.parse(readFileSync(new URL('./fixtures.json',import.meta.url),'utf8')).cases;
function run(cases,extra=[]) {
 const dir=mkdtempSync(join(tmpdir(),'hushavyr-benchmark-'));
 try { const path=join(dir,'results.json');writeFileSync(path,JSON.stringify({cases}));
 return spawnSync(process.execPath,['benchmarks/evaluate.mjs','--results',path,...extra],{encoding:'utf8'});
 } finally {rmSync(dir,{recursive:true,force:true});}
}
test('perfect multilingual predictions score 100%',()=>{
 const p=run(fixtures.map(f=>({id:f.id,findings:f.expected.map(ruleId=>({ruleId}))})),['--min-precision','1','--min-recall','1']);
 assert.equal(p.status,0,p.stderr);const r=JSON.parse(p.stdout);assert.equal(r.precision,1);assert.equal(r.recall,1);
});
test('missing positives and spurious clean findings fail thresholds',()=>{
 const p=run(fixtures.map(f=>({id:f.id,findings:f.category==='clean'?[{ruleId:'false-alarm'}]:[]})),['--min-precision','0.9','--min-recall','0.9']);
 assert.equal(p.status,1);const r=JSON.parse(p.stdout);assert.ok(r.counts.fp>0);assert.ok(r.counts.fn>0);
});
test('missing language case is rejected rather than silently omitted',()=>{
 const p=run(fixtures.slice(1).map(f=>({id:f.id,findings:[]})));
 assert.notEqual(p.status,0);assert.match(p.stderr,/Missing case/);
});
