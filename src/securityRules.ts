/** Conservative, offline security checks. These are indicators, not exploit proofs. */
export interface SecurityIssue {line:number; rule:string; severity:"HIGH"|"MEDIUM"; advice:string}
type Rule={id:string;severity:"HIGH"|"MEDIUM";pattern:RegExp;advice:string;extensions:RegExp}
const ANY=/\.(?:java|kt|js|ts|py|go|cs|php|rb|rs)$/;
const rules:Rule[]=[
{id:"SQL string concatenation",severity:"HIGH",pattern:/\b(?:query|execute|exec|raw)\s*\(\s*(?:"[^"]*\b(?:SELECT|INSERT|UPDATE|DELETE)\b[^"]*"\s*\+|'[^']*\b(?:SELECT|INSERT|UPDATE|DELETE)\b[^']*'\s*\+|f["'][^"']*\b(?:SELECT|INSERT|UPDATE|DELETE)\b[^"']*\{|`[^`]*\b(?:SELECT|INSERT|UPDATE|DELETE)\b[^`]*\$\{)/i,advice:"Use parameterized queries and bind variables; never build SQL from request data",extensions:ANY},
{id:"SQL string concatenation",severity:"HIGH",pattern:/\b(?:executeQuery|executeUpdate|prepareStatement)\s*\(\s*(?:[^)]*\+|(?:sql|query)\s*\))/,advice:"Use parameterized queries and bind variables; inspect how SQL is constructed",extensions:/\.(?:java|kt|js|ts|py)$/},
{id:"TLS certificate validation disabled",severity:"HIGH",pattern:/\b(?:rejectUnauthorized\s*:\s*false|verify\s*=\s*False|InsecureSkipVerify\s*:\s*true|ServerCertificateValidationCallback\s*[+]?=\s*\(?[^)]*\)?\s*=>\s*true|CURLOPT_SSL_VERIFYPEER\s*,\s*(?:false|0)|verify_mode\s*=\s*OpenSSL::SSL::VERIFY_NONE|danger_accept_invalid_certs\s*\(\s*true\s*\)|checkServerTrusted\s*\([^)]*\)\s*\{\s*\}|InsecureTrustManagerFactory\.INSTANCE)(?![A-Za-z0-9_])/,advice:"Enable certificate and hostname validation",extensions:ANY},
{id:"Weak cryptographic hash",severity:"MEDIUM",pattern:/\b(?:MessageDigest\.getInstance\s*\(\s*["'](?:MD5|SHA-1)["']|createHash\s*\(\s*["'](?:md5|sha1)["']|hashlib\.(?:md5|sha1)\s*\()/i,advice:"Avoid weak hashes for security-sensitive purposes; verify usage context",extensions:/\.(?:java|kt|js|ts|py)$/},
{id:"SQL string concatenation",severity:"HIGH",pattern:/\b(?:execute|query|query_row|query_map|prepare|query_as)\s*\(\s*&?format!\s*\(\s*"[^"]*\b(?:SELECT|INSERT|UPDATE|DELETE)\b/i,advice:"Use bound parameters (?1, $1) instead of format! for SQL",extensions:/\.rs$/},
{id:"Weak cryptographic hash",severity:"MEDIUM",pattern:/\b(?:md5::compute\s*\(|Md5::(?:new|digest)\s*\(|Sha1::(?:new|digest)\s*\()/,advice:"Avoid weak hashes for security-sensitive purposes; verify usage context",extensions:/\.rs$/},
{id:"Potential command execution",severity:"MEDIUM",pattern:/\bCommand::new\s*\(\s*"(?:sh|bash|zsh|cmd(?:\.exe)?|powershell(?:\.exe)?)"/,advice:"Review user-controlled arguments and run the program directly with .arg() instead of a shell",extensions:/\.rs$/},
{id:"Java deserialization",severity:"MEDIUM",pattern:/\bnew\s+ObjectInputStream\s*\(|\bObjectInputStream\s*\(/,advice:"Avoid deserializing untrusted objects; enforce serialization filters",extensions:/\.(?:java|kt)$/},
{id:"Unsafe dynamic code evaluation",severity:"MEDIUM",pattern:/(?<![\w.$])eval\s*\(\s*(?!["'`])[^)\s]|\bnew\s+Function\s*\(\s*(?!["'`])[^)\s]/,advice:"Avoid evaluating dynamic strings; use a parser or a fixed set of operations",extensions:/\.(?:js|ts|php|rb)$/},
{id:"Unsafe Python deserialization",severity:"HIGH",pattern:/\b(?:pickle\.loads?|marshal\.loads?)\s*\(|\byaml\.load\s*\((?![^)]*Loader\s*=\s*(?:yaml\.)?(?:Safe|CSafe)Loader)/,advice:"Never deserialize untrusted data with pickle/marshal; use yaml.safe_load",extensions:/\.py$/},
{id:"Potential command execution",severity:"MEDIUM",pattern:/\b(?:exec\.Command\s*\(\s*"(?:sh|bash|cmd)"|Process\.Start\s*\(|shell_exec\s*\(|system\s*\(\s*\$)/,advice:"Review user-controlled arguments and prefer argument arrays without a shell",extensions:/\.(?:go|cs|php|rb)$/},
{id:"Potential command execution",severity:"MEDIUM",pattern:/\b(?:Runtime\.getRuntime\(\)\.exec|child_process\.exec\s*\(|os\.system\s*\(|subprocess\.(?:run|Popen)\s*\()/,advice:"Review user-controlled arguments and prefer argument arrays without a shell",extensions:/\.(?:java|kt|js|ts|py)$/}
];
export function scanSecurity(path:string,source:string):SecurityIssue[]{
 const results:SecurityIssue[]=[];if(!ANY.test(path))return results;
 const lines=source.split(/\r?\n/);
 for(let i=0;i<lines.length&&i<20000;i++){
  const line=lines[i];if(/^\s*(?:\/\/|#|\*)/.test(line))continue;
  for(const rule of rules)if(rule.extensions.test(path)&&rule.pattern.test(line)){
   results.push({line:i+1,rule:rule.id,severity:rule.severity,advice:rule.advice});
   if(results.length>=200)return results;
  }
 }
 return results;
}
