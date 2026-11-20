import {basename,dirname,join} from "node:path";
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
