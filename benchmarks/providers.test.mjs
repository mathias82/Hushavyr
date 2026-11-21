import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const exec=(script,args)=>spawnSync(process.execPath,[join(root,'benchmarks',script),...args],{cwd:root,encoding:'utf8',timeout:10000});
test('cloud provider cannot run without explicit consent',()=>{
 const p=exec('execute-providers.mjs',['--provider','copilot','--model','test']);
 assert.notEqual(p.status,0);assert.match(p.stderr,/approve-synthetic-cloud/);
});
test('reject invalid provider',()=>{
 const p=exec('execute-providers.mjs',['--provider','untrusted','--model','test']);
 assert.notEqual(p.status,0);assert.match(p.stderr,/Unsupported provider/);
});
test('reject incomplete recorded provider run without contacting models',()=>{
 const dir=mkdtempSync(join(tmpdir(),'hushavyr-provider-test-'));
 try{
  const a=join(dir,'bad.json'),out=join(dir,'combined.json');
  writeFileSync(a,JSON.stringify({provider:'copilot',model:'test',responses:{case1:''},errors:{}}));
  const p=exec('combine-providers.mjs',['--out',out,a]);
  assert.notEqual(p.status,0);assert.match(p.stderr,/Missing or empty/);
 }finally{rmSync(dir,{recursive:true,force:true})}
});
test('combine valid synthetic provider results without invoking models',()=>{
 const dir=mkdtempSync(join(tmpdir(),'hushavyr-provider-test-'));
 try{
  const a=join(dir,'a.json'),out=join(dir,'combined.json');
  writeFileSync(a,JSON.stringify({provider:'ollama',model:'local-test',responses:{case1:'{"findings":[]}'},timings:{case1:5}}));
  const p=exec('combine-providers.mjs',['--out',out,a]);
  assert.equal(p.status,0,p.stderr);
  assert.equal(JSON.parse(readFileSync(out,'utf8')).providers['ollama/local-test'].case1,'{"findings":[]}');
 }finally{rmSync(dir,{recursive:true,force:true})}
});
