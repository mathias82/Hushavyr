#!/usr/bin/env node
// Merge measured provider response files into the existing benchmark comparison format.
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
const args=process.argv.slice(2),i=args.indexOf('--out');
if(i<0||!args[i+1])throw Error('Usage: node benchmarks/combine-providers.mjs --out comparison-input.json provider1.json provider2.json');
const out=resolve(args[i+1]),inputs=args.filter((v,j)=>j!==i&&j!==i+1);
if(!inputs.length)throw Error('Provide at least one measured response file');
const providers={},metadata={};
for(const file of inputs){
 const result=JSON.parse(readFileSync(resolve(file),'utf8'));
 if(!result.provider||!result.model||!result.responses)throw Error('Invalid provider response file');
 if(Object.keys(result.errors||{}).length)throw Error('Provider run contains failures: '+file);
 const key=result.provider+'/'+result.model;
 if(providers[key])throw Error('Duplicate provider/model: '+key);
 providers[key]=result.responses;metadata[key]={recordedAt:result.recordedAt,timings:result.timings};
}
writeFileSync(out,JSON.stringify({providers},null,2)+'\n');
writeFileSync(out.replace(/\.json$/,'.metadata.json'),JSON.stringify(metadata,null,2)+'\n');
console.log(out);
