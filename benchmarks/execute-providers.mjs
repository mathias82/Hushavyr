#!/usr/bin/env node
// Synthetic fixture-only provider runner. Cloud is explicit opt-in, never a fallback.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {spawn} from 'node:child_process';
const args=process.argv.slice(2);
const opt=(key,fallback)=>{const i=args.indexOf(key);return i<0?fallback:args[i+1]};
const provider=opt('--provider','ollama'),model=opt('--model',provider==='ollama'?'qwen2.5-coder:7b':'');
const input=opt('--prompts','benchmarks/copilot-prompts.json'),out=resolve(opt('--out','benchmarks/provider-responses.json'));
const approval=args.includes('--approve-synthetic-cloud');
if(!['ollama','openai','copilot'].includes(provider))throw Error('Unsupported provider');
if(!model||!/^[a-zA-Z0-9][\w.:/-]{0,127}$/.test(model))throw Error('Specify a valid --model');
if(provider!=='ollama'&&!approval)throw Error('Cloud transfer requires --approve-synthetic-cloud');
const file=JSON.parse(readFileSync(resolve(input),'utf8'));
if(file.privacy!=='SYNTHETIC FIXTURES ONLY - manually verify before sharing'||!file.prompts||typeof file.prompts!=='object')throw Error('Only verified synthetic prompt exports accepted');
const prompts=Object.entries(file.prompts);
if(!prompts.length)throw Error('No benchmark prompts');
function run(command,argv,prompt){
 return new Promise((yes,no)=>{const child=spawn(command,argv,{stdio:['pipe','pipe','pipe'],env:process.env});let stdout='',stderr='';
  const timer=setTimeout(()=>child.kill('SIGKILL'),180000);
  child.stdout.on('data',b=>{stdout+=b.toString();if(stdout.length>500000)child.kill('SIGKILL')});
  child.stderr.on('data',b=>{stderr+=b.toString().slice(0,2000)});
  child.on('error',e=>{clearTimeout(timer);no(e)});
  child.on('close',code=>{clearTimeout(timer);code===0?yes(stdout):no(Error('Provider CLI failed: '+stderr.slice(0,200)))});
  child.stdin.end(prompt);
 });
}
async function ask(prompt){
 if(provider==='ollama'){
  const base='http://127.0.0.1:11434';
  const tags=await fetch(base+'/api/tags');if(!tags.ok)throw Error('Ollama unavailable');
  const models=(await tags.json()).models||[];
  const entry=models.find(m=>m.name===model||m.name===model+':latest');
  if(!entry||entry.remote_model||entry.remote_host)throw Error('Local model not verified');
  const info=await fetch(base+'/api/show',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model})});
  if(!info.ok)throw Error('Model metadata unavailable');
  const meta=await info.json();if(meta.remote_model||meta.remote_host||!meta.model_info)throw Error('Remote model rejected');
  const res=await fetch(base+'/api/generate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model,prompt,stream:false,options:{temperature:0}}),signal:AbortSignal.timeout(180000)});
  if(!res.ok)throw Error('Ollama failed');return (await res.json()).response;
 }
 if(provider==='openai'){
  if(!process.env.OPENAI_API_KEY)throw Error('OPENAI_API_KEY is required (separate API billing)');
  const res=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{authorization:'Bearer '+process.env.OPENAI_API_KEY,'content-type':'application/json'},body:JSON.stringify({model,input:prompt,store:false}),signal:AbortSignal.timeout(180000)});
  if(!res.ok)throw Error('OpenAI request failed: HTTP '+res.status);
  const data=await res.json();return (data.output||[]).flatMap(x=>x.content||[]).filter(x=>x.type==='output_text').map(x=>x.text).join('\n');
 }
 // Copilot CLI must be installed, authenticated and support -p / --model in the user's environment.
 return (await run('copilot',['-p',prompt,'--model',model,'--silent','--no-ask-user'],'' )).trim();
}
const responses={},timings={},errors={};
for(const [id,prompt] of prompts){
 const started=performance.now();
 try{responses[id]=await ask(prompt);if(!responses[id])throw Error('Empty response')}
 catch(e){errors[id]=e instanceof Error?e.message:'Provider failure';responses[id]=''}
 timings[id]=Math.round(performance.now()-started);
 console.log(id+': '+(errors[id]?'ERROR':'done')+' '+timings[id]+'ms');
}
mkdirSync(dirname(out),{recursive:true});
writeFileSync(out,JSON.stringify({schemaVersion:1,provider,model,recordedAt:new Date().toISOString(),responses,timings,errors,privacy:'synthetic benchmark prompts only'},null,2)+'\n');
console.log('Saved '+out);if(Object.keys(errors).length)process.exitCode=1;
