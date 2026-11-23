/** Conservative, offline security checks. These are indicators, not exploit proofs. */
export interface SecurityIssue {line:number; rule:string; severity:"HIGH"|"MEDIUM"; advice:string}
/** context: the rule only fires when nearby code (20 lines either side) shows a security use. statement: the pattern sees the whole statement, continued while brackets are open. */
type Rule={id:string;severity:"HIGH"|"MEDIUM";pattern:RegExp;advice:string;extensions:RegExp;context?:RegExp;statement?:boolean}
const SECRET_USE=/token|passw|secret|nonce|\bsalt|\botp\b|session|cookie|rememberme|csrf|api_?key|credential|captcha|\bpin\b|\biv\b|crypt|signature/i;
const ANY=/\.(?:java|kt|js|ts|py|go|cs|php|rb|rs)$/;
const rules:Rule[]=[
{id:"SQL string concatenation",severity:"HIGH",pattern:/\b(?:query|execute|exec|raw)\s*\(\s*(?:"[^"]*\b(?:SELECT|INSERT|UPDATE|DELETE)\b[^"]*"\s*\+|'[^']*\b(?:SELECT|INSERT|UPDATE|DELETE)\b[^']*'\s*\+|f["'][^"']*\b(?:SELECT|INSERT|UPDATE|DELETE)\b[^"']*\{|`[^`]*\b(?:SELECT|INSERT|UPDATE|DELETE)\b[^`]*\$\{)/i,advice:"Use parameterized queries and bind variables; never build SQL from request data",extensions:ANY},

{id:"TLS certificate validation disabled",severity:"HIGH",pattern:/\b(?:rejectUnauthorized\s*:\s*false|verify\s*=\s*False|InsecureSkipVerify\s*:\s*true|ServerCertificateValidationCallback\s*[+]?=\s*\(?[^)]*\)?\s*=>\s*true|CURLOPT_SSL_VERIFYPEER\s*,\s*(?:false|0)|verify_mode\s*=\s*OpenSSL::SSL::VERIFY_NONE|danger_accept_invalid_certs\s*\(\s*true\s*\)|checkServerTrusted\s*\([^)]*\)\s*\{\s*\}|InsecureTrustManagerFactory\.INSTANCE)(?![A-Za-z0-9_])/,advice:"Enable certificate and hostname validation",extensions:ANY},
{id:"Weak cryptographic hash",severity:"MEDIUM",pattern:/\b(?:MessageDigest\.getInstance\s*\(\s*["'](?:MD[245]|SHA|SHA-?1)["']|createHash\s*\(\s*["'](?:md5|sha1)["']|hashlib\.(?:md5|sha1)\s*\()/i,advice:"Avoid weak hashes for security-sensitive purposes; verify usage context",extensions:/\.(?:java|kt|js|ts|py)$/},
{id:"SQL string concatenation",severity:"HIGH",pattern:/\b(?:execute|query|query_row|query_map|prepare|query_as)\s*\(\s*&?format!\s*\(\s*"[^"]*\b(?:SELECT|INSERT|UPDATE|DELETE)\b/i,advice:"Use bound parameters (?1, $1) instead of format! for SQL",extensions:/\.rs$/},
{id:"Weak cryptographic hash",severity:"MEDIUM",pattern:/\b(?:md5::compute\s*\(|Md5::(?:new|digest)\s*\(|Sha1::(?:new|digest)\s*\()/,advice:"Avoid weak hashes for security-sensitive purposes; verify usage context",extensions:/\.rs$/},
{id:"Potential command execution",severity:"MEDIUM",pattern:/\bCommand::new\s*\(\s*"(?:sh|bash|zsh|cmd(?:\.exe)?|powershell(?:\.exe)?)"/,advice:"Review user-controlled arguments and run the program directly with .arg() instead of a shell",extensions:/\.rs$/},
{id:"Weak cryptographic hash",severity:"MEDIUM",pattern:/\bhashlib\.new\s*\(\s*(?:name\s*=\s*)?["'](?:md[245]|sha1?)["'](?![^)]*usedforsecurity\s*=\s*False)/i,advice:"Avoid weak hashes for security-sensitive purposes; verify usage context",extensions:/\.py$/},
{id:"Insecure cookie",severity:"MEDIUM",pattern:/\.set_cookie\s*\((?=[^]*\bsecure\s*=\s*False\b)/,advice:"Set secure=True so the cookie is only sent over HTTPS",extensions:/\.py$/,statement:true},
{id:"Insecure random number generator",severity:"MEDIUM",pattern:/(?<![\w.])random\.(?:random|randint|randrange|randbytes|getrandbits|choice|choices|sample|shuffle|uniform|triangular|gauss|normalvariate|lognormvariate|expovariate|betavariate|gammavariate|paretovariate|vonmisesvariate|weibullvariate)\s*\(/,advice:"Use the secrets module or random.SystemRandom for tokens, IDs, passwords and keys",extensions:/\.py$/,context:SECRET_USE},
{id:"Weak encryption algorithm",severity:"MEDIUM",pattern:/\b(?:Cipher|KeyGenerator|SecretKeyFactory)\.getInstance\s*\(\s*"(?:(?:DES|DESede|TripleDES|RC2|RC4|ARCFOUR|Blowfish)(?:\/[^"]*)?|[^"]*\/ECB\/[^"]*)"/i,advice:"Use AES/GCM/NoPadding with a random IV; DES, RC4 and ECB mode leak plaintext patterns",extensions:/\.(?:java|kt)$/},
{id:"Insecure random number generator",severity:"MEDIUM",pattern:/\bnew\s+(?:java\.util\.)?Random\s*\(|\bMath\.random\s*\(/,advice:"Use java.security.SecureRandom for tokens, IDs, passwords and keys",extensions:/\.(?:java|kt)$/,context:SECRET_USE},
{id:"Java deserialization",severity:"MEDIUM",pattern:/\bnew\s+ObjectInputStream\s*\(|\bObjectInputStream\s*\(/,advice:"Avoid deserializing untrusted objects; enforce serialization filters",extensions:/\.(?:java|kt)$/},
{id:"Unsafe dynamic code evaluation",severity:"MEDIUM",pattern:/(?<![\w.$])eval\s*\(\s*(?!["'`])[^)\s]|\bnew\s+Function\s*\(\s*(?!["'`])[^)\s]/,advice:"Avoid evaluating dynamic strings; use a parser or a fixed set of operations",extensions:/\.(?:js|ts|php|rb)$/},
{id:"Unsafe Python deserialization",severity:"HIGH",pattern:/\b(?:pickle\.loads?|marshal\.loads?)\s*\(|\byaml\.load\s*\((?![^)]*Loader\s*=\s*(?:yaml\.)?(?:Safe|CSafe)Loader)/,advice:"Never deserialize untrusted data with pickle/marshal; use yaml.safe_load",extensions:/\.py$/},
{id:"Potential command execution",severity:"MEDIUM",pattern:/\b(?:exec\.Command\s*\(\s*"(?:sh|bash|cmd)"|Process\.Start\s*\(|shell_exec\s*\(|system\s*\(\s*\$)/,advice:"Review user-controlled arguments and prefer argument arrays without a shell",extensions:/\.(?:go|cs|php|rb)$/},
{id:"Potential command execution",severity:"MEDIUM",pattern:/\b(?:Runtime\.getRuntime\(\)\.exec|child_process\.exec\s*\(|os\.system\s*\(|subprocess\.(?:run|Popen)\s*\()/,advice:"Review user-controlled arguments and prefer argument arrays without a shell",extensions:/\.(?:java|kt|js|ts|py)$/},
{id:"XML external entities enabled",severity:"HIGH",pattern:/\bnoent\s*:\s*true\b|\bXML_PARSE_(?:NOENT|DTDLOAD)\b/,advice:"Keep entity substitution and external DTD loading disabled when parsing untrusted XML",extensions:/\.(?:js|ts)$/},
{id:"XML external entities enabled",severity:"HIGH",pattern:/\bLIBXML_NOENT\b|\blibxml_disable_entity_loader\s*\(\s*false\s*\)/,advice:"Do not pass LIBXML_NOENT when parsing untrusted XML",extensions:/\.php$/},
{id:"XML external entities enabled",severity:"HIGH",pattern:/\bDtdProcessing\s*=\s*DtdProcessing\.Parse\b|\bProhibitDtd\s*=\s*false\b|\bXmlResolver\s*=\s*new\s+XmlUrlResolver\b/,advice:"Keep DtdProcessing.Prohibit and XmlResolver = null for untrusted XML",extensions:/\.cs$/},
{id:"Angular sanitizer bypass",severity:"MEDIUM",pattern:/\.bypassSecurityTrust(?:Html|Script|Style|Url|ResourceUrl)\s*\(\s*(?!["'`]|\s*\))/,advice:"Do not bypass Angular sanitization for values that can contain user input",extensions:/\.(?:ts|js)$/},
{id:"Node vm is not a sandbox",severity:"MEDIUM",pattern:/\bvm\.runIn(?:New|This)?Context\s*\(|\bnew\s+vm\.Script\s*\(/,advice:"node:vm does not isolate untrusted code; use a separate process or a real sandbox",extensions:/\.(?:js|ts)$/},
{id:"SQL string concatenation",severity:"HIGH",pattern:/\bfmt\.Sprintf\s*\(\s*["`][^"`]*\b(?:SELECT|INSERT|UPDATE|DELETE)\b[^"`]*%[sv]/i,advice:"Use placeholders (?, $1) and pass values to Query/Exec instead of fmt.Sprintf",extensions:/\.go$/},
{id:"SQL string concatenation",severity:"HIGH",pattern:/(?:\bnew\s+\w*(?:Command|DataAdapter)\s*\(|\.CommandText\s*=)\s*(?:\$@?"[^"]*\b(?:SELECT|INSERT|UPDATE|DELETE|select|insert|update|delete)\b[^"]*\{|"[^"]*\b(?:SELECT|INSERT|UPDATE|DELETE|select|insert|update|delete)\b[^"]*"\s*\+(?!\s*(?:[A-Z][A-Z0-9_]*\s*(?:[+;]|$)|$)))/,advice:"Use SqlParameter / command.Parameters instead of building SQL strings",extensions:/\.cs$/},
{id:"SQL string concatenation",severity:"HIGH",pattern:/\b(?:mysqli_query|mysql_query|pg_query|sqlite_query)\s*\([^"']*"[^"]*\b(?:SELECT|INSERT|UPDATE|DELETE)\b[^"]*\$\w|->(?:query|exec)\s*\(\s*"[^"]*\b(?:SELECT|INSERT|UPDATE|DELETE)\b[^"]*\$\w/i,advice:"Use prepared statements with bound parameters (PDO/mysqli prepare)",extensions:/\.php$/},
{id:"Weak cryptographic hash",severity:"MEDIUM",pattern:/\b(?:md5|sha1)\.(?:New|Sum)\s*\(/,advice:"Avoid weak hashes for security-sensitive purposes; verify usage context",extensions:/\.go$/},
{id:"Weak cryptographic hash",severity:"MEDIUM",pattern:/\b(?:MD5|SHA1)\.Create\s*\(|\bnew\s+(?:MD5|SHA1)(?:CryptoServiceProvider|Managed|Cng)\s*\(/,advice:"Avoid weak hashes for security-sensitive purposes; verify usage context",extensions:/\.cs$/},
{id:"Weak cryptographic hash",severity:"MEDIUM",pattern:/(?<![\w>$:])(?:md5|sha1)\s*\(/,advice:"Use password_hash() for passwords and hash('sha256') or hash_hmac for tokens",extensions:/\.php$/,context:SECRET_USE},
{id:"Weak cryptographic hash",severity:"MEDIUM",pattern:/\bDigest::(?:MD5|SHA1)\b/,advice:"Avoid weak hashes for security-sensitive purposes; verify usage context",extensions:/\.rb$/},
{id:"Weak encryption algorithm",severity:"MEDIUM",pattern:/\b(?:DES|TripleDES|RC2)\.Create\s*\(|\bnew\s+(?:DES|TripleDES|RC2)CryptoServiceProvider\s*\(|\bCipherMode\.ECB\b/,advice:"Use AES-GCM with a random nonce; DES, RC2 and ECB mode leak plaintext patterns",extensions:/\.cs$/},
{id:"Weak encryption algorithm",severity:"MEDIUM",pattern:/\b(?:des\.NewCipher|des\.NewTripleDESCipher|rc4\.NewCipher)\s*\(/,advice:"Use AES-GCM with a random nonce; DES and RC4 are broken",extensions:/\.go$/},
{id:"Unsafe .NET deserialization",severity:"HIGH",pattern:/\bnew\s+(?:BinaryFormatter|NetDataContractSerializer|LosFormatter|SoapFormatter|ObjectStateFormatter)\s*\(|\bTypeNameHandling\s*=\s*TypeNameHandling\.(?!None\b)\w+/,advice:"Do not deserialize untrusted data with type-embedding formatters; use System.Text.Json with fixed types",extensions:/\.cs$/},
{id:"Insecure random number generator",severity:"MEDIUM",pattern:/\bnew\s+(?:System\.)?Random\s*\(/,advice:"Use RandomNumberGenerator for tokens, IDs, passwords and keys",extensions:/\.cs$/,context:SECRET_USE},
{id:"Insecure random number generator",severity:"MEDIUM",pattern:/\brand\.(?:Intn|Int31n?|Int63n?|Uint32|Uint64|Float32|Float64|Perm|Shuffle)\s*\(/,advice:"Use crypto/rand for tokens, IDs, passwords and keys",extensions:/\.go$/,context:SECRET_USE},
{id:"Insecure random number generator",severity:"MEDIUM",pattern:/(?<![\w>$:])(?:rand|mt_rand|uniqid|lcg_value)\s*\(/,advice:"Use random_bytes() or random_int() for tokens, IDs, passwords and keys",extensions:/\.php$/,context:SECRET_USE},
{id:"PHP variable overwrite",severity:"HIGH",pattern:/\bextract\s*\(\s*\$_(?:GET|POST|REQUEST|COOKIE)\b/,advice:"Never extract() request data; read the fields you need explicitly",extensions:/\.php$/},
{id:"Request validation disabled",severity:"MEDIUM",pattern:/\[\s*ValidateInput\s*\(\s*false\s*\)\s*\]|\bvalidateRequest\s*=\s*"false"/i,advice:"Keep ASP.NET request validation on and encode output",extensions:/\.cs$/},
{id:"CSRF protection disabled",severity:"MEDIUM",pattern:/\bskip_before_action\s+:verify_authenticity_token\b|\bprotect_from_forgery\b[^#\n]*\bexcept\b/,advice:"Keep CSRF verification on for browser-facing actions",extensions:/\.rb$/},
{id:"Mass assignment",severity:"MEDIUM",pattern:/\bparams(?:\.require\([^)]*\))?\.permit!|\.to_unsafe_h\b/,advice:"Whitelist attributes with params.require(...).permit(:a, :b)",extensions:/\.rb$/}
];
/** The statement starting at line i, joined while brackets stay open (at most 20 lines). */
function statement(lines:string[],i:number):string{
 let text="",depth=0;
 for(let j=i;j<lines.length&&j<i+20;j++){text+=lines[j]+"\n";for(const c of lines[j])depth+="([{".includes(c)?1:")]}".includes(c)?-1:0;if(depth<=0)break}
 return text;
}
export function scanSecurity(path:string,source:string):SecurityIssue[]{
 const results:SecurityIssue[]=[];if(!ANY.test(path))return results;
 const lines=source.split(/\r?\n/);
 for(let i=0;i<lines.length&&i<20000;i++){
  const line=lines[i];if(/^\s*(?:\/\/|#|\*)/.test(line))continue;
  for(const rule of rules)if(rule.extensions.test(path)&&rule.pattern.test(rule.statement?statement(lines,i):line)&&(!rule.context||rule.context.test(lines.slice(Math.max(0,i-20),i+21).join("\n")))){
   results.push({line:i+1,rule:rule.id,severity:rule.severity,advice:rule.advice});
   if(results.length>=200)return results;
  }
 }
 return results;
}
