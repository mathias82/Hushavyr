import {join} from "node:path";
import {access,mkdtemp,open,readFile,readdir,rm,writeFile} from "node:fs/promises";
import {homedir,tmpdir} from "node:os";
import {exec} from "../util/exec";
export interface DependencyVulnerability {id:string;pkg:string;installed:string;fixed?:string;severity:string;title:string;target:string;source?:"osv"}
export interface DependencyAudit {status:"ok"|"missing"|"failed"|"unsupported";manager?:string;findings:number;note:string;vulnerabilities?:DependencyVulnerability[]}
const SEVERITY_ORDER=["CRITICAL","HIGH","MEDIUM","LOW","UNKNOWN"];
/** Scanner output is untrusted: keep short printable text only. */
const clean=(value:unknown,max:number):string=>typeof value==="string"?value.replace(/[^\x20-\x7E]/g," ").replace(/\s+/g," ").trim().slice(0,max):"";
/** Extracts CVE rows from Trivy JSON, worst severity first. */
export function parseTrivyVulnerabilities(parsed:unknown):DependencyVulnerability[]{
 const rows=(parsed as {Results?:unknown[]})?.Results;if(!Array.isArray(rows))return [];
 const found:DependencyVulnerability[]=[];
 for(const row of rows){
  const target=clean((row as {Target?:unknown})?.Target,120);
  const vulns=(row as {Vulnerabilities?:unknown[]})?.Vulnerabilities;if(!Array.isArray(vulns))continue;
  for(const v of vulns as Record<string,unknown>[]){
   const id=clean(v?.VulnerabilityID,40);if(!id)continue;
   const severity=clean(v.Severity,10).toUpperCase()||"UNKNOWN";
   found.push({id,pkg:clean(v.PkgName,120),installed:clean(v.InstalledVersion,40),fixed:clean(v.FixedVersion,80)||undefined,severity,title:clean(v.Title,140),target});
  }
 }
 const rank=(s:string)=>{const i=SEVERITY_ORDER.indexOf(s);return i<0?SEVERITY_ORDER.length:i};
 return found.sort((a,b)=>rank(a.severity)-rank(b.severity)||a.id.localeCompare(b.id));
}
async function exists(path:string):Promise<boolean>{try{await access(path);return true}catch{return false}}

/** License banners of browser libraries that projects often copy in instead of installing (name -> npm package). */
// The name must start a comment line: "Buttons for DataTables 1.2.0" or "requires DataTables 1.10.1" are other packages.
const BANNER_START=/(?:^|\n)[ \t]*(?:\/\*+!?|\*|\/\/!?)?[ \t]*/.source,VERSION=/(\d+\.\d+\.\d+)/.source;
const banner=(name:string)=>new RegExp(BANNER_START+name+VERSION);
const VENDORED_BANNERS:[RegExp,string][]=[
 [banner("jQuery UI - v"),"jquery-ui"],
 [banner("jQuery (?:JavaScript Library )?v"),"jquery"],
 [banner("Bootstrap v"),"bootstrap"],
 [banner("DataTables "),"datatables.net"],
 [/\/\/! moment\.js\s*\n\/\/! version : (\d+\.\d+\.\d+)/,"moment"],
 [banner("@license AngularJS v"),"angular"],
 [banner("handlebars v"),"handlebars"],
 [banner("Underscore[.]js "),"underscore"],
 [banner("Knockout JavaScript library v"),"knockout"],
 [banner("Select2 "),"select2"],
];
export interface VendoredLibrary {pkg:string;version:string;path:string}
/** Library and version from the banner at the top of a copied-in .js file; only the first 400 characters count so plugin headers that mention jQuery do not match. */
export function vendoredLibrary(text:string):{pkg:string;version:string}|undefined{
 const head=text.slice(0,400);
 for(const [re,pkg] of VENDORED_BANNERS){const m=re.exec(head);if(m)return {pkg,version:m[1]}}
 return undefined;
}
/** Copied-in browser libraries (jquery.min.js and similar) that no manifest lists; one entry per package version. */
export async function findVendoredLibraries(root:string,limit=20000):Promise<VendoredLibrary[]>{
 const found=new Map<string,VendoredLibrary>();let seen=0;
 const walk=async(dir:string,rel:string,depth:number):Promise<void>=>{
  if(depth>10||seen>limit)return;
  let entries;try{entries=await readdir(dir,{withFileTypes:true})}catch{return}
  for(const e of entries){
   if(++seen>limit)return;
   const path=rel?rel+"/"+e.name:e.name;
   if(e.isDirectory()){if(!/^\.|^node_modules$|^bower_components$/.test(e.name))await walk(join(dir,e.name),path,depth+1);continue}
   if(!e.isFile()||!/\.js$/i.test(e.name))continue;
   let text="";try{const h=await open(join(dir,e.name),"r");try{const b=Buffer.alloc(400);const {bytesRead}=await h.read(b,0,400,0);text=b.toString("utf8",0,bytesRead)}finally{await h.close()}}catch{continue}
   const lib=vendoredLibrary(text);
   if(lib&&!found.has(lib.pkg+"@"+lib.version))found.set(lib.pkg+"@"+lib.version,{...lib,path});
  }
 };
 await walk(root,"",0);
 return [...found.values()];
}
/** Trivy reads the copied-in libraries from a temporary CycloneDX SBOM, offline like the manifest scan. */
async function scanVendored(libs:readonly VendoredLibrary[],signal?:AbortSignal):Promise<DependencyVulnerability[]>{
 const dir=await mkdtemp(join(tmpdir(),"hushavyr-vendored-"));
 try{
  const purl=(l:VendoredLibrary)=>"pkg:npm/"+l.pkg+"@"+l.version;
  const bom={bomFormat:"CycloneDX",specVersion:"1.5",version:1,metadata:{component:{type:"application",name:"vendored","bom-ref":"root"}},
   components:libs.map(l=>({type:"library",name:l.pkg,version:l.version,purl:purl(l),"bom-ref":purl(l)}))};
  const file=join(dir,"vendored.cdx.json");
  await writeFile(file,JSON.stringify(bom));
  const {stdout}=await exec("trivy",["sbom","--offline-scan","--skip-db-update","--skip-java-db-update","--scanners","vuln","--format","json","--quiet",file],{
   timeout:120000,maxBuffer:8*1024*1024,windowsHide:true,signal,env:{...process.env,TRIVY_DISABLE_VEX_NOTICE:"true"}});
  const where=new Map(libs.map(l=>[l.pkg+"@"+l.version,l.path]));
  return parseTrivyVulnerabilities(JSON.parse(stdout)).map(v=>({...v,target:where.get(v.pkg+"@"+v.installed)??v.target}));
 }finally{await rm(dir,{recursive:true,force:true})}
}
/** Offline-only scanner: Trivy must have a locally cached vulnerability database. */
export async function auditDependencies(root:string,signal?:AbortSignal):Promise<DependencyAudit>{
 const manifestAudit=await auditManifests(root,signal);
 const libs=await findVendoredLibraries(root);
 if(!libs.length||manifestAudit.status==="missing"||manifestAudit.status==="failed")return manifestAudit;
 const names=libs.map(l=>l.pkg+" "+l.version).join(", ");
 let vendored:DependencyVulnerability[];
 try{vendored=await scanVendored(libs,signal)}catch(e){
  if((e as NodeJS.ErrnoException).code==="ENOENT")return {status:"missing",findings:0,manager:"vendored js",note:"Copied-in libraries found ("+names+"). Install Trivy and provision its vulnerability database locally first"};
  return manifestAudit.status==="ok"?manifestAudit:{status:"failed",manager:"vendored js",findings:0,note:"Offline scan of copied-in libraries failed; check local database availability and scanner setup"};
 }
 const sorted=[...(manifestAudit.vulnerabilities??[]),...vendored].sort((a,b)=>{const r=(s:string)=>{const i=SEVERITY_ORDER.indexOf(s);return i<0?SEVERITY_ORDER.length:i};return r(a.severity)-r(b.severity)||a.id.localeCompare(b.id)});
 const note="Copied-in libraries checked: "+names+(manifestAudit.status==="ok"?". "+manifestAudit.note:"");
 return {status:"ok",manager:[manifestAudit.manager,"vendored js"].filter(Boolean).join(", "),findings:manifestAudit.findings+vendored.length,vulnerabilities:sorted,note};
}
async function auditManifests(root:string,signal?:AbortSignal):Promise<DependencyAudit>{
 const supported:[string,string][]=[["pom.xml","maven"],["package-lock.json","npm"],["requirements.txt","pip"],["poetry.lock","poetry"],["Pipfile.lock","pipenv"],["build.gradle","gradle"],["build.gradle.kts","gradle"],["yarn.lock","yarn"],["pnpm-lock.yaml","pnpm"],["go.mod","go"],["Cargo.lock","cargo"],["composer.lock","composer"],["Gemfile.lock","bundler"],["packages.lock.json","nuget"]];
 // Trivy scans recursively, so manifests in direct subfolders (api/, backend/) count too.
 const dirs=[root];
 try{for(const e of await readdir(root,{withFileTypes:true}))if(e.isDirectory()&&!/^\.|^(?:node_modules|vendor|target|build|dist|out)$/.test(e.name))dirs.push(join(root,e.name))}catch{/* unreadable root */}
 const names:string[]=[];
 for(const [file,name] of supported)for(const dir of dirs){if(!names.includes(name)&&await exists(join(dir,file)))names.push(name)}
 let npmWithoutLock=false;
 if(!names.some(n=>["npm","yarn","pnpm"].includes(n)))for(const dir of dirs)if(await exists(join(dir,"package.json"))){npmWithoutLock=true;break}
 const manager=names.join(", ")||undefined;
 const lockHint="package.json has no lockfile; run npm install --package-lock-only so npm packages can be checked";
 if(!manager)return {status:"unsupported",findings:0,note:npmWithoutLock?lockHint:"No supported dependency manifest found"};
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
  const vulnerabilities=parseTrivyVulnerabilities(parsed);
  return {status:"ok",manager,findings,vulnerabilities,note:"Local Trivy database used; coverage depends on cached database freshness and supported ecosystems"+(npmWithoutLock?". "+lockHint:"")};
 }catch(e){
  const err=e as NodeJS.ErrnoException;
  return {status:err.code==="ENOENT"?"missing":"failed",manager,findings:0,note:(err.code==="ENOENT"?"Install Trivy and provision its vulnerability database locally first":"Offline scan failed; check local database availability and scanner setup")+(npmWithoutLock?". "+lockHint:"")};
 }
}

export interface GroupedVulnerability extends Omit<DependencyVulnerability,"target"> {targets:string[]}
/** One row per CVE and package version; the same vulnerability in parent and module POMs is listed once. */
export function groupVulnerabilities(list:readonly DependencyVulnerability[]):GroupedVulnerability[]{
 const groups=new Map<string,GroupedVulnerability>();
 for(const v of list){
  const key=[v.id,v.pkg,v.installed].join("|");
  const existing=groups.get(key);
  if(!existing){const {target,...rest}=v;groups.set(key,{...rest,targets:target?[target]:[]})}
  else if(v.target&&!existing.targets.includes(v.target))existing.targets.push(v.target);
 }
 return [...groups.values()];
}
/** 1-based line of the dependency declaration in a manifest, or 1 when it is only inherited (BOM, parent). */
export function findDependencyLine(text:string,pkg:string,installed?:string):number{
 const artifact=pkg.includes(":")?pkg.split(":").pop()!:pkg;
 const escaped=artifact.replace(/[.*+?^${}()|[\]]/g,"\\$&");
 const patterns=[new RegExp("<artifactId>\\s*"+escaped+"\\s*</artifactId>"),new RegExp("[\"']"+escaped+"[\"']"),new RegExp("^\\s*"+escaped+"(?:\\s|[=<>~!;]|$)","i")];
 const lines=text.split(/\r?\n/);
 const esc=(v:string)=>v.replace(/[.*+?^${}()|[\]]/g,"\\$&");
 if(installed){const stem=artifact.split(/[-_.]/)[0];if(stem.length>2)patterns.push(new RegExp("<[\\w.-]*"+esc(stem)+"[\\w.-]*>\\s*"+esc(installed)+"\\s*</"))}
 for(const pattern of patterns){const i=lines.findIndex(l=>pattern.test(l));if(i>=0)return i+1}
 return 1;
}

/** Trivy can list several fixed versions; prefer one in the installed major line (smallest upgrade risk). */
export function firstFixedVersion(fixed:string,installed:string):string|undefined{
 const options=fixed.split(/[,\s]+/).filter(v=>/^v?\d[\w.+-]*$/.test(v));
 const major=installed.split(".")[0];
 return options.find(v=>v.replace(/^v/,"").split(".")[0]===major)??options[0];
}
/** Replaces the installed version with the fixed one on a single manifest line; undefined when the version is not on it. */
export function bumpVersion(line:string,installed:string,fixed:string):string|undefined{
 if(!installed||!fixed||installed===fixed)return undefined;
 const pattern=new RegExp("(?<![\\w.])"+installed.replace(/[.*+?^${}()|[\]]/g,"\\$&")+"(?![\\w.])");
 return pattern.test(line)?line.replace(pattern,()=>fixed):undefined;
}
/** Reads back the marker text written by the dependency scan (VS Code recreates Diagnostic objects). */
export function parseMarkerMessage(message:string):{id:string;pkg:string;installed:string;fixed:string}|undefined{
 const m=/^(\S+) in (\S+) (\S+) \(\w+\)\. Fixed in (.+)\.$/.exec(message);
 return m?{id:m[1],pkg:m[2],installed:m[3],fixed:m[4]}:undefined;
}
/** Writes a CycloneDX SBOM locally; no network access. */
export async function exportSbom(root:string,output:string,signal?:AbortSignal):Promise<{ok:boolean;note:string}>{
 try{
  await exec("trivy",["fs","--offline-scan","--skip-db-update","--skip-java-db-update","--format","cyclonedx","--output",output,"--quiet","."],{cwd:root,timeout:120000,windowsHide:true,signal});
  return {ok:true,note:"SBOM written locally"};
 }catch(e){return {ok:false,note:(e as NodeJS.ErrnoException).code==="ENOENT"?"Install Trivy first":"SBOM export failed"}}
}

/** Whole days since the Trivy vulnerability database was last published, from its metadata.json. */
export function dbAgeDays(metadata:string,now=Date.now()):number|undefined{
 try{
  const updated=Date.parse((JSON.parse(metadata) as {UpdatedAt?:string}).UpdatedAt??"");
  return Number.isFinite(updated)?Math.max(0,Math.floor((now-updated)/86_400_000)):undefined;
 }catch{return undefined}
}
/** Age of the locally cached database, or undefined when it cannot be found. */
export async function trivyDbAgeDays():Promise<number|undefined>{
 const dirs=[process.env.TRIVY_CACHE_DIR,join(homedir(),"Library","Caches","trivy"),join(homedir(),".cache","trivy"),process.env.LOCALAPPDATA&&join(process.env.LOCALAPPDATA,"trivy")];
 for(const dir of dirs){
  if(!dir)continue;
  try{return dbAgeDays(await readFile(join(dir,"db","metadata.json"),"utf8"))}catch{/* try next location */}
 }
 return undefined;
}

/** Hours since the Trivy database was downloaded (falls back to its publish time). */
export function dbAgeHours(metadata:string,now=Date.now()):number|undefined{
 try{
  const m=JSON.parse(metadata) as {DownloadedAt?:string;UpdatedAt?:string};
  const at=Date.parse(m.DownloadedAt??m.UpdatedAt??"");
  return Number.isFinite(at)?Math.max(0,Math.floor((now-at)/3_600_000)):undefined;
 }catch{return undefined}
}
export async function trivyDbAgeHours():Promise<number|undefined>{
 const dirs=[process.env.TRIVY_CACHE_DIR,join(homedir(),"Library","Caches","trivy"),join(homedir(),".cache","trivy"),process.env.LOCALAPPDATA&&join(process.env.LOCALAPPDATA,"trivy")];
 for(const dir of dirs){
  if(!dir)continue;
  try{return dbAgeHours(await readFile(join(dir,"db","metadata.json"),"utf8"))}catch{/* try next location */}
 }
 return undefined;
}
/** "3 h ago" / "2 days ago" / "not downloaded". */
export function formatDbAge(hours:number|undefined):string{
 if(hours===undefined)return "not downloaded";
 return hours<1?"less than 1 h ago":hours<48?hours+" h ago":Math.floor(hours/24)+" days ago";
}
/** A database older than a day (or missing) may lack CVEs published today. */
export const dbIsStale=(hours:number|undefined):boolean=>hours===undefined||hours>24;
/** The manifest that declares the direct dependencies behind a lockfile Trivy reported. */
export function manifestFor(target:string):string{
 const map:Record<string,string>={"package-lock.json":"package.json","npm-shrinkwrap.json":"package.json","yarn.lock":"package.json","pnpm-lock.yaml":"package.json","bun.lock":"package.json",
  "poetry.lock":"pyproject.toml","uv.lock":"pyproject.toml","Pipfile.lock":"Pipfile","Cargo.lock":"Cargo.toml","composer.lock":"composer.json","Gemfile.lock":"Gemfile","go.sum":"go.mod",
  "gradle.lockfile":"build.gradle","packages.lock.json":"*.csproj"};
 const name=target.split(/[\\/]/).pop()??target;
 return map[name]?target.slice(0,target.length-name.length)+map[name]:target;
}
/** True when the manifest names the package itself (not only through another dependency). */
export function isDirectDependency(manifest:string,pkg:string):boolean{
 const name=pkg.includes(":")?pkg.split(":").pop()!:pkg;
 const quoted=name.replace(/[.*+?^${}()|[\]]/g,"\\$&");
 if(new RegExp("[\"'<>]"+quoted+"[\"'<>]").test(manifest))return true;
 // requirements.txt, go.mod and Gemfile lines; go.mod marks transitive ones `// indirect`.
 return manifest.split(/\r?\n/).some(l=>!/\/\/\s*indirect/.test(l)&&new RegExp("^\\s*(?:require\\s+|gem\\s+)?[\"']?"+quoted+"[\"']?(?:\\s|[=<>~!;[]|$)","i").test(l));
}
/** One concrete, copyable way to remove the vulnerability; undefined when no fixed version exists. */
export function dependencyFix(target:string,pkg:string,installed:string,fixed:string|undefined,direct:boolean):string|undefined{
 const version=fixed?firstFixedVersion(fixed,installed):undefined;
 if(!version||!/^[\w@./:+-]+$/.test(pkg))return undefined;
 const file=(target.split(/[\\/]/).pop()??"").toLowerCase(),v=version.replace(/^v/,"");
 if(/^(package(-lock)?\.json|npm-shrinkwrap\.json)$/.test(file))return direct?"`npm install "+pkg+"@"+v+"`":"add `\"overrides\": {\""+pkg+"\": \""+v+"\"}` to package.json, then `npm install` (`npm ls "+pkg+"` shows which package pulls it in)";
 if(file==="yarn.lock")return direct?"`yarn add "+pkg+"@"+v+"`":"add `\"resolutions\": {\""+pkg+"\": \""+v+"\"}` to package.json, then `yarn install`";
 if(file==="pnpm-lock.yaml")return direct?"`pnpm add "+pkg+"@"+v+"`":"add `\"pnpm\": {\"overrides\": {\""+pkg+"\": \""+v+"\"}}` to package.json, then `pnpm install`";
 if(/requirements.*\.txt$|^pipfile(\.lock)?$/.test(file))return "`pip install \""+pkg+">="+v+"\"` and set `"+pkg+">="+v+"` in "+(file.startsWith("pipfile")?"Pipfile":file);
 if(/^(poetry\.lock|pyproject\.toml)$/.test(file))return "`poetry add \""+pkg+"@>="+v+"\"`";
 if(file==="uv.lock")return "`uv add \""+pkg+">="+v+"\"`";
 if(/^go\.(mod|sum)$/.test(file))return "`go get "+pkg+"@v"+v+" && go mod tidy`";
 if(/^cargo\.(lock|toml)$/.test(file))return direct?"set `"+pkg+" = \""+v+"\"` in Cargo.toml, then `cargo update -p "+pkg+"`":"`cargo update -p "+pkg+" --precise "+v+"`";
 if(/^composer\.(lock|json)$/.test(file))return direct?"`composer require \""+pkg+":^"+v+"\"`":"`composer update "+pkg+" --with-dependencies`";
 if(/^gemfile(\.lock)?$/.test(file))return "`bundle update "+pkg+"` (needs "+v+" or later)";
 if(file==="pom.xml"){const [g,a]=pkg.split(":");return a?(direct?"set `<version>"+v+"</version>` for `"+a+"` in pom.xml":"pin it in `<dependencyManagement>`: `<groupId>"+g+"</groupId><artifactId>"+a+"</artifactId><version>"+v+"</version>`"):undefined;}
 if(/\.gradle(\.kts)?$|^gradle\.lockfile$/.test(file))return direct?"use `"+pkg+":"+v+"` in build.gradle":"add `constraints { implementation(\""+pkg+":"+v+"\") }` to build.gradle";
 if(/\.csproj$|^packages\.lock\.json$/.test(file))return "`dotnet add package "+pkg+" --version "+v+"`";
 if(/\.js$/.test(file))return "replace the copied-in "+file+" with "+pkg+" "+v+" or later from its official release, then retest the pages that use it";
 return "upgrade "+pkg+" to "+v+" or later";
}
export interface DependencyFinding {id:string;pkg:string;installed:string;fixed?:string}
/** Reads a dependency CVE back from any Hushavyr message: editor marker, CLI/terminal line or chat report row. */
export function parseDependencyFinding(message:string):DependencyFinding|undefined{
 const text=message.replace(/`/g,"");
 const id=/\b(CVE-\d{4}-\d{4,}|GHSA(?:-[a-z0-9]{4}){3}|(?:PYSEC|GO|RUSTSEC|OSV)-\d{4}-[\w-]+)\b/i.exec(text);
 if(!id)return undefined;
 const rest=text.slice(id.index+id[0].length);
 const pkg=/^(?:\s+in\s+|\s*·\s*(?:OSV\s*·\s*)?|\s+)([@\w][\w@./:+-]*)\s+(v?\d[\w.+-]*)/.exec(rest);
 if(!pkg)return undefined;
 const fixed=/(?:fixed in|διορθώνεται στο)\s+([^·:;)\n]+?)\s*(?:[.·:;)]\s|[.·:;)]?$|\s·)/i.exec(rest);
 return {id:id[1],pkg:pkg[1],installed:pkg[2],fixed:fixed?.[1].trim()||undefined};
}
export interface DependencyFixPlan {
 /** Manifest to change (relative like the target). */
 manifest:string;
 /** What to do, shown to the user and given to the local model. */
 advice:string;
 /** A safe deterministic edit of the manifest, when the version is on one of its lines. */
 updated?:string;
 /** Command that refreshes the lockfile afterwards. */
 then?:string;
 /** A copied-in library file: replacing it is a manual step, never an AI edit of the library. */
 manual?:boolean;
}
const INSTALL:Record<string,string>={"package.json":"npm install","Cargo.toml":"cargo update","composer.json":"composer update","Gemfile":"bundle install","go.mod":"go mod tidy","pyproject.toml":"poetry lock","Pipfile":"pipenv lock"};
/** Plans the upgrade; manifestPath/manifestText come from resolveManifest (undefined text: edit the target itself). */
export function planDependencyFix(target:string,finding:DependencyFinding,manifestText:string|undefined,manifestPath=manifestFor(target)):DependencyFixPlan|undefined{
 const version=finding.fixed?firstFixedVersion(finding.fixed,finding.installed):undefined;
 if(!version)return undefined;
 if(/\.js$/i.test(target))return {manifest:target,advice:dependencyFix(target,finding.pkg,finding.installed,finding.fixed,false)!,manual:true};
 const manifest=manifestText===undefined||manifestPath.includes("*")?target:manifestPath;
 const direct=manifestText!==undefined&&isDirectDependency(manifestText,finding.pkg);
 const advice=dependencyFix(target,finding.pkg,finding.installed,finding.fixed,direct)??"upgrade "+finding.pkg+" to "+version;
 const name=manifest.split(/[\\/]/).pop()??"";
 const then=manifest!==target?(name==="package.json"&&/yarn\.lock$/.test(target)?"yarn install":name==="package.json"&&/pnpm-lock\.yaml$/.test(target)?"pnpm install":INSTALL[name]):undefined;
 if(manifestText!==undefined&&direct){
  const lines=manifestText.split("\n"),at=findDependencyLine(manifestText,finding.pkg,finding.installed)-1;
  const bumped=lines[at]!==undefined?bumpVersion(lines[at],finding.installed,version.replace(/^v/,"")):undefined;
  if(bumped){lines[at]=bumped;return {manifest,advice,updated:lines.join("\n"),then};}
 }
 return {manifest,advice,then};
}
/** Instruction for the local model when no deterministic edit exists (transitive dependency, version range, property). */
export function dependencyEditInstruction(finding:DependencyFinding,plan:DependencyFixPlan):string{
 return "Fix "+finding.id+": "+finding.pkg+" "+finding.installed+" is vulnerable; "+plan.advice.replace(/`/g,"")+
  ". Edit ONLY this manifest so the fixed version is used. Change nothing else, keep the formatting, and keep the file valid.";
}
/** The model's manifest is accepted only if it is still valid and now names the fixed version. */
export function acceptManifestEdit(manifest:string,before:string,after:string,finding:DependencyFinding):boolean{
 const version=finding.fixed?firstFixedVersion(finding.fixed,finding.installed)?.replace(/^v/,""):undefined;
 if(!version||after===before||!after.includes(version)||!after.includes(finding.pkg.split(":").pop()!))return false;
 if(/\.json$/i.test(manifest)){try{JSON.parse(after);}catch{return false;}}
 return true;
}
/** Finds and reads the manifest that declares the dependencies of a lockfile (target itself if none). */
export async function resolveManifest(target:string):Promise<{path:string;text?:string}>{
 let path=manifestFor(target);
 if(path.endsWith("*.csproj")){
  const dir=path.slice(0,-"*.csproj".length);
  const project=(await readdir(dir||".").catch(()=>[] as string[])).find(n=>n.endsWith(".csproj"));
  if(!project)return {path:target,text:await readFile(target,"utf8").catch(()=>undefined)};
  path=dir+project;
 }
 const text=await readFile(path,"utf8").catch(()=>undefined);
 return text===undefined&&path!==target?{path:target,text:await readFile(target,"utf8").catch(()=>undefined)}:{path,text};
}
