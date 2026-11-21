#!/usr/bin/env node
// Executes the REAL compiled Hushavyr CLI, never imports or changes production scanner logic.
import {readFile,writeFile,mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {spawn} from 'node:child_process';
const root=resolve(import.meta.dirname,'..');
const fixtures=JSON.parse(await readFile(new URL('./fixtures.json',import.meta.url),'utf8')).cases;
const cli=join(root,'dist','cli.js');
const out=resolve(process.argv[process.argv.indexOf('--out')+1]||'benchmarks/results.json');
const timeoutMs=Number(process.env.HUSHAVYR_BENCH_TIMEOUT_MS||'90000');
if(!Number.isFinite(timeoutMs)||timeoutMs<1000||timeoutMs>600000)throw Error('Invalid timeout');
async function execute(args,cwd){
 return new Promise((done,fail)=>{
  const child=spawn(process.execPath,args,{cwd,env:{...process.env,CI:'true'},stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='',ended=false;
  const timer=setTimeout(()=>{child.kill('SIGKILL');fail(Error('scanner timeout'))},timeoutMs);
  for(const [stream,append] of [[child.stdout,s=>stdout+=s],[child.stderr,s=>stderr+=s]])
   stream.on('data',b=>{append(b.toString().slice(0,20000));});
  child.on('error',e=>{clearTimeout(timer);if(!ended){ended=true;fail(e)}});
  child.on('close',code=>{clearTimeout(timer);if(!ended){ended=true;done({code,stdout,stderr})}});
 });
}
const results=[];
for(const fixture of fixtures){
 const dir=await mkdtemp(join(tmpdir(),'hushavyr-polyglot-'));
 try{
  const target=join(dir,fixture.path);
  await mkdir(dirname(target),{recursive:true});
  await writeFile(target,fixture.code,'utf8');
  const sarif=join(dir,'results.sarif');
  const started=performance.now();
  const run=await execute([cli,dir,'--sarif',sarif,'--fail-on','none'],root);
  if(run.code!==0)throw Error('Scanner failed for '+fixture.id+': '+run.stderr.slice(0,1000));
  const report=JSON.parse(await readFile(sarif,'utf8'));
  const findings=(report.runs||[]).flatMap(r=>r.results||[]).map(f=>({ruleId:String(f.ruleId||''),path:f.locations?.[0]?.physicalLocation?.artifactLocation?.uri||''}));
  results.push({id:fixture.id,findings,durationMs:Math.round(performance.now()-started)});
  console.log(fixture.id+': '+findings.length+' findings');
 } finally {await rm(dir,{recursive:true,force:true})}
}
await mkdir(dirname(out),{recursive:true});
await writeFile(out,JSON.stringify({schemaVersion:1,scanner:'Hushavyr CLI',cases:results},null,2)+'\n');
console.log('Saved '+out);
