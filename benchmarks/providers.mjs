#!/usr/bin/env node
// Provider-neutral benchmark exchange: generate prompts and score recorded responses.
// Never transmits code, reads credentials, or invokes a cloud provider.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
const root=resolve(new URL('..',import.meta.url).pathname);
const cli=resolve(root,'dist/benchmark.js');
const [action,...args]=process.argv.slice(2);
const arg=(name,fallback)=>{const i=args.indexOf(name);return i<0?fallback:args[i+1]};
function invoke(flags){
 const result=spawnSync(process.execPath,[cli,...flags],{cwd:root,encoding:'utf8',maxBuffer:10*1024*1024,timeout:120000});
 if(result.error||result.status!==0)throw Error('Benchmark CLI failed: '+(result.error?.message||result.stderr));
 return JSON.parse(result.stdout);
}
function save(path,data){const out=resolve(path);mkdirSync(dirname(out),{recursive:true});writeFileSync(out,JSON.stringify(data,null,2)+'\n');console.log(out)}
if(action==='export'){
 const out=arg('--out','benchmarks/copilot-prompts.json');
 const prompts=invoke(['--prompts']);
 save(out,{schemaVersion:1,privacy:'SYNTHETIC FIXTURES ONLY - manually verify before sharing',prompts});
}else if(action==='score'){
 const file=arg('--responses');if(!file)throw Error('Provide --responses <file>');
 const data=JSON.parse(readFileSync(resolve(file),'utf8'));
 if(!data.providers||typeof data.providers!=='object')throw Error('Expected {providers:{name:{fixtureId:responseString}}}');
 // Reuse the existing production-independent benchmark scorer for exact same fixture labels.
 const report=invoke(['--compare',resolve(file)]);
 save(arg('--out','benchmarks/provider-comparison.json'),{schemaVersion:1,source:'recorded provider responses',...report});
}else{console.error('Usage: node benchmarks/providers.mjs export [--out file] | score --responses file [--out file]');process.exitCode=2}
