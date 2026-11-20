import {execFile} from "node:child_process";
import {resolve, relative, isAbsolute} from "node:path";

export interface SemgrepFinding {path:string;line:number;rule:string;severity:string;message:string}
export interface SemgrepResult {status:"ok"|"missing"|"failed";findings:SemgrepFinding[];error?:string}
type Runner = (file:string,args:string[],options:object,callback:(error:Error|null,stdout:string,stderr:string)=>void)=>void;

/** Semgrep is invoked locally, without registry rules or network-dependent configuration. */
export async function runSemgrep(root:string,runner:Runner=execFile as unknown as Runner):Promise<SemgrepResult>{
 const args=["scan","--config","auto"]; // replaced below: auto downloads rules, which is forbidden.
 args.splice(2,2,"--config","p/security-audit");
 // Do not use remote rulesets. Only built-in local rule file is accepted.
 args.splice(2,2,"--config",resolve(__dirname,"..","rules","hushavyr-semgrep.yml"));
 args.push("--json","--disable-version-check","--metrics=off","--no-git-ignore",root);
 return new Promise(resolveResult=>runner("semgrep",args,{cwd:root,timeout:120000,maxBuffer:8*1024*1024,windowsHide:true,env:{...process.env,SEMGREP_SEND_METRICS:"off",SEMGREP_ENABLE_VERSION_CHECK:"0"}},(error,stdout)=>{
   if(error && (error as NodeJS.ErrnoException).code==="ENOENT"){resolveResult({status:"missing",findings:[]});return;}
   let parsed:unknown;try{parsed=JSON.parse(stdout)}catch{resolveResult({status:"failed",findings:[],error:"Semgrep did not return valid JSON"});return;}
   const data=parsed as {results?:unknown[];errors?:unknown[]};
   if(!Array.isArray(data.results)||error){resolveResult({status:"failed",findings:[],error:"Semgrep scan failed or returned incomplete results"});return;}
   const findings:SemgrepFinding[]=[];
   for(const item of data.results.slice(0,500)){if(!item||typeof item!=="object")continue;
     const f=item as {path?:unknown;start?:{line?:unknown};check_id?:unknown;extra?:{severity?:unknown;message?:unknown}};
     if(typeof f.path!=="string")continue;
     const full=resolve(root,f.path),rel=relative(root,full);
     if(rel.startsWith("..")||isAbsolute(rel))continue;
     const line=f.start?.line;if(typeof line!=="number"||!Number.isInteger(line)||line<1)continue;
     findings.push({path:rel,line,rule:String(f.check_id??"local-rule").slice(0,120),severity:String(f.extra?.severity??"WARNING").slice(0,30),message:String(f.extra?.message??"Review finding").slice(0,300)});
   }
   resolveResult({status:"ok",findings});
 }));
}
