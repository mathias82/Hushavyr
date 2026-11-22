import {dirname,extname,join,relative,resolve,sep} from "node:path";
import {fileURLToPath} from "node:url";
import {readFile} from "node:fs/promises";
import {ReviewSource} from "./context";
/** Bounded same-project Java context. Only follows explicitly imported project classes. */
export async function relatedJavaSources(root:string,source:ReviewSource):Promise<ReviewSource[]>{
 const text=source.text;
 if(!/\.java(?:$|[?#])/.test(source.path))return [];
 const imports=[...text.matchAll(/^import\s+([\w.]+);/gm)].map(x=>x[1])
  .filter(x=>!x.startsWith("java.")&&!x.startsWith("javax.")&&!x.startsWith("jakarta.")&&!x.startsWith("org.springframework."));
 const base=join(root,"src","main","java");
 const result:ReviewSource[]=[];
 for(const name of imports.slice(0,12)){
  const parts=name.split(".");
  if(parts.some(p=>p===".."||!/^\w+$/.test(p)))continue;
  const path=join(base,...parts)+".java";
  try{
   const data=await readFile(path);
   if(data.length>0&&data.length<=25000&&!data.includes(0)){
    result.push({path:name.replace(/\./g,"/")+".java",text:data.toString("utf8"),startLine:1});
   }
  }catch{/* Not a local source import */}
  if(result.length>=3)break;
 }
 return result;
}

const SCRIPT=/\.(?:[cm]?[jt]sx?|py)$/;
const SCRIPT_EXT=[".ts",".tsx",".js",".jsx",".mjs",".cjs"];
/** Module specifiers a TypeScript/JavaScript or Python file loads from the same project. */
export function localImportSpecifiers(path:string,text:string):string[]{
 if(path.endsWith(".py")){
  const found=[...text.matchAll(/^\s*from\s+(\.+)([\w.]*)\s+import\b/gm)].map(m=>m[1]+m[2]);
  for(const m of text.matchAll(/^\s*from\s+([A-Za-z_][\w.]*)\s+import\b/gm))found.push(m[1]);
  return found;
 }
 const found:string[]=[];
 for(const m of text.matchAll(/(?:from\s+|import\s*\(?\s*|require\(\s*)["'](\.{1,2}\/[^"'\r\n]+)["']/g))found.push(m[1]);
 return found;
}
async function readSmall(path:string):Promise<string|undefined>{
 try{const data=await readFile(path);if(data.length>0&&data.length<=25000&&!data.includes(0))return data.toString("utf8")}catch{/* not a file */}
 return undefined;
}
/** Bounded same-project context for TypeScript/JavaScript and Python files: relative or project-local imports only. */
export async function relatedScriptSources(root:string,source:ReviewSource):Promise<ReviewSource[]>{
 if(!source.path.startsWith("file:")||!SCRIPT.test(source.path))return [];
 let file:string;try{file=fileURLToPath(source.path)}catch{return []}
 const base=resolve(root);
 if(!resolve(file).startsWith(base+sep))return [];
 const py=file.endsWith(".py");
 const result:ReviewSource[]=[];
 for(const spec of localImportSpecifiers(file,source.text).slice(0,12)){
  let candidates:string[];
  if(py){
   const dots=/^\.*/.exec(spec)![0].length;
   const name=spec.slice(dots).split(".").filter(Boolean);
   if(name.some(part=>!/^\w+$/.test(part))||!name.length)continue;
   const origin=dots?resolve(dirname(file),...Array(dots-1).fill("..")):base;
   candidates=[join(origin,...name)+".py",join(origin,...name,"__init__.py")];
  }else{
   const target=resolve(dirname(file),spec);
   candidates=extname(target)&&SCRIPT_EXT.includes(extname(target))?[target]:[...SCRIPT_EXT.map(e=>target+e),...SCRIPT_EXT.map(e=>join(target,"index"+e))];
  }
  for(const candidate of candidates){
   const full=resolve(candidate);
   if(!full.startsWith(base+sep)||full===resolve(file)||full.split(sep).includes("node_modules"))continue;
   const text=await readSmall(full);
   if(text!==undefined){result.push({path:relative(base,full).split(sep).join("/"),text,startLine:1});break}
  }
  if(result.length>=3)break;
 }
 return result;
}
/** Related project files for any supported language. */
export async function relatedSources(root:string,source:ReviewSource):Promise<ReviewSource[]>{
 return [...await relatedJavaSources(root,source),...await relatedScriptSources(root,source)];
}
