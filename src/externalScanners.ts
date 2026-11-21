import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {resolve,relative,isAbsolute,join} from "node:path";
import {mkdtemp,readFile,rm,access} from "node:fs/promises";
import {tmpdir} from "node:os";
const run=promisify(execFile);
export type Scanner="semgrep"|"gitleaks";
export interface ScannerFinding {tool:Scanner;rule:string;severity:string;path:string;line:number;message?:string;fix?:string}
export interface ScannerResult {tool:Scanner;status:"ok"|"missing"|"failed";findings:ScannerFinding[];reason?:"rules-missing"|"execution-failed"|"invalid-output"}
function safePath(root:string,p:string):string|undefined{
 const rel=relative(root,resolve(root,p));
 return rel&&!rel.startsWith("..")&&!isAbsolute(rel)?rel.replace(/\\/g,"/"):undefined;
}
export function parseScannerOutput(tool:Scanner,output:string,root:string):ScannerFinding[]{
 let data:unknown;try{data=JSON.parse(output)}catch{return []}
 const rows=tool==="semgrep"?(data as {results?:unknown[]})?.results:data;
 if(!Array.isArray(rows))return [];
 const findings:ScannerFinding[]=[];
 for(const row of rows.slice(0,500)){
  if(!row||typeof row!=="object")continue;
  const item=row as Record<string,unknown>,extra=(item.extra??{}) as Record<string,unknown>,start=(item.start??{}) as Record<string,unknown>;
  const rawPath=tool==="semgrep"?item.path:item.File;
  const path=typeof rawPath==="string"?safePath(root,rawPath):undefined;
  const line=tool==="semgrep"?start.line:item.StartLine;
  const rule=tool==="semgrep"?item.check_id:item.RuleID;
  if(!path||!Number.isInteger(line)||(line as number)<1||typeof rule!=="string")continue;
  const severity=tool==="semgrep"?extra.severity:"HIGH";
  // Semgrep prefixes rule ids with the config path; only bundled Hushavyr rules (no metavariables) may show their text.
  const own=tool==="semgrep"&&/(?:^|\.)hushavyr\.[\w-]+$/.test(rule);
  const meta=(extra.metadata??{}) as Record<string,unknown>;
  const text=(v:unknown):string|undefined=>own&&typeof v==="string"?v.replace(/[\r\n`\[\]<>]/g," ").slice(0,200):undefined;
  const finding:ScannerFinding={tool,rule:(own?rule.split(".").pop()!:rule).slice(0,120),severity:typeof severity==="string"?severity.slice(0,24):"UNKNOWN",path,line:line as number};
  if(own){const message=text(extra.message),fix=text(meta.fix);if(message)finding.message=message;if(fix)finding.fix=fix;}
  findings.push(finding);
 }
 return findings;
}
export async function runScanner(tool:Scanner,root:string,semgrepRules:string,signal?:AbortSignal):Promise<ScannerResult>{
 if(tool==="semgrep"){try{await access(semgrepRules)}catch{return {tool,status:"failed",findings:[],reason:"rules-missing"}}}
 const temp=await mkdtemp(join(tmpdir(),"hushavyr-scan-"));
 const report=join(temp,"gitleaks.json");
 const args=tool==="semgrep"
  ?["scan","--config",semgrepRules,"--json","--metrics=off","--disable-version-check","."]
  :["detect","--source",".","--report-format","json","--report-path",report,"--no-banner","--no-git"];
 try{
  let stdout="";
  try{({stdout}=await run(tool,args,{cwd:root,timeout:120000,maxBuffer:8*1024*1024,windowsHide:true,signal,env:{...process.env,SEMGREP_SEND_METRICS:"off",SEMGREP_ENABLE_VERSION_CHECK:"0"}}));}
  catch(e){
   const err=e as NodeJS.ErrnoException&{stdout?:string;code?:string|number};
   if(err.code==="ENOENT")return {tool,status:"missing",findings:[]};
   if(typeof err.stdout!=="string"&&err.code!=="1")return {tool,status:"failed",findings:[],reason:"execution-failed"};
   stdout=err.stdout??"";
  }
  if(tool==="gitleaks"){try{stdout=await readFile(report,"utf8")}catch{return {tool,status:"failed",findings:[]}}}
  if(!stdout.trim())return {tool,status:"failed",findings:[]};
  let parsed:unknown;try{parsed=JSON.parse(stdout)}catch{return {tool,status:"failed",findings:[]}}
  if(tool==="semgrep"&&(!parsed||!Array.isArray((parsed as {results?:unknown[]}).results)))return {tool,status:"failed",findings:[]};
  if(tool==="gitleaks"&&!Array.isArray(parsed))return {tool,status:"failed",findings:[]};
  return {tool,status:"ok",findings:parseScannerOutput(tool,stdout,root)};
 }finally{await rm(temp,{recursive:true,force:true})}
}
