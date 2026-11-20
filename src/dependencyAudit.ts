import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {join} from "node:path";
import {access} from "node:fs/promises";
const exec=promisify(execFile);
export interface DependencyAudit {status:"ok"|"missing"|"failed"|"unsupported";manager?:string;findings:number;note:string}
async function exists(path:string):Promise<boolean>{try{await access(path);return true}catch{return false}}
/** Offline-only scanner: Trivy must have a locally cached vulnerability database. */
export async function auditDependencies(root:string,signal?:AbortSignal):Promise<DependencyAudit>{
 const supported:[string,string][]=[["pom.xml","maven"],["package-lock.json","npm"],["requirements.txt","pip"],["poetry.lock","poetry"],["Pipfile.lock","pipenv"],["build.gradle","gradle"],["build.gradle.kts","gradle"]];
 let manager:string|undefined;
 for(const [file,name] of supported){if(await exists(join(root,file))){manager=name;break}}
 if(!manager)return {status:"unsupported",findings:0,note:"No supported dependency manifest found"};
 try{
  const {stdout}=await exec("trivy",["fs","--offline-scan","--skip-db-update","--skip-java-db-update","--scanners","vuln","--format","json","--quiet","."],{
   cwd:root,timeout:120000,maxBuffer:8*1024*1024,windowsHide:true,signal,
   env:{...process.env,TRIVY_DISABLE_VEX_NOTICE:"true"}
  });
  let parsed:unknown;try{parsed=JSON.parse(stdout)}catch{return {status:"failed",manager,findings:0,note:"Scanner output invalid or local vulnerability database unavailable"}}
  const rows=(parsed as {Results?:unknown[]})?.Results;
  if(!Array.isArray(rows))return {status:"failed",manager,findings:0,note:"Scanner did not return complete results"};
  let findings=0;
  for(const row of rows){const vulns=(row as {Vulnerabilities?:unknown[]})?.Vulnerabilities;if(Array.isArray(vulns))findings+=vulns.length}
  return {status:"ok",manager,findings,note:"Local Trivy database used; coverage depends on cached database freshness and supported ecosystems"};
 }catch(e){
  const err=e as NodeJS.ErrnoException;
  return {status:err.code==="ENOENT"?"missing":"failed",manager,findings:0,note:err.code==="ENOENT"?"Install Trivy and provision its vulnerability database locally first":"Offline scan failed; check local database availability and scanner setup"};
 }
}
