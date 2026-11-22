import {createHash} from "node:crypto";
import {definedNames, definitionSnippet} from "./callContext";
import {initJavaParser, JavaFile, JavaProject, parseJava} from "./javaAst";
import {pythonToBraces} from "./pythonBlocks";
import {parseSyntax, SyntaxFile} from "./syntax";

export {initJavaParser};
// Loading starts at import, so a scan that reads files first finds the parser ready; await initJavaParser() to be sure.
void initJavaParser();

/**
 * Project-wide (interprocedural, cross-file) taint tracking without a model or Semgrep Pro.
 * Each function gets a summary "parameter i reaches sink K" and "parameter i reaches the return value"; summaries are
 * propagated through calls to a fixpoint, then request input (req.query, @RequestParam, getParameter...) is followed into them.
 * Statements are tracked with their block context, so constant conditions, constant switch selectors and constant
 * collection slots do not carry taint, and assignments inside conditional branches only add taint.
 * Heuristic and line-based: it reports a path to verify, not a proof. Java files are parsed with tree-sitter when the parser
 * is loaded (initJavaParser): methods, parameters and annotations come from the syntax tree, comments are ignored, and a
 * call on a receiver of a declared type resolves only to that type's methods (and only reaches a SQL, command, LDAP, XPath
 * or session sink on a matching API type). JS/TS, PHP, Go, C# and Ruby files get functions, parameters and blanked comments
 * from their own grammars (syntax.ts). Python files are first rewritten into the same brace form (pythonBlocks), so
 * constant branches, match cases and dict/list slots work there too; an if block that always leaves validates what its
 * condition checks (if "../" in name: return), and a Flask route's return value is its HTML response.
 */
export type SinkKind = "sql" | "nosql" | "command" | "code" | "path" | "ssrf" | "xss" | "ldap" | "xpath" | "trust-boundary" | "redirect" | "xxe" | "deserialization";
export interface TaintFile { path: string; text: string }
export interface TaintFlow { kind: SinkKind; source: {path: string; line: number}; sink: {path: string; line: number}; via: string[] }

const JAVA = /\.(?:java|kt)$/i;
const PY = /\.py$/i;
const JS = /\.(?:[cm]?js|jsx|tsx?)$/i;
const GO = /\.go$/i;
const CS = /\.cs$/i;
const PHP = /\.php$/i;
const RB = /\.rb$/i;
const BRACES = /\.(?:java|kt|js|jsx|mjs|cjs|ts|tsx|cs|php|go|rs|scala|swift)$/i;
/** arg: which argument is the tainted one (default the first; all: any); unless: a statement that makes the call safe.
 * recv: the tainted value is the receiver before the call (value.constantize); skip: an argument shape that is safe (a Rails
 * hash condition); lit: the argument's first string literal must match (header("Location: " . $url)); shell: when the first
 * argument is a shell (exec.Command("sh", "-c", cmd)), every argument counts. */
interface Sink { kind: SinkKind; call: RegExp; when?: RegExp; unless?: RegExp; lang?: RegExp; scope?: RegExp; all?: boolean; arg?: number; recv?: boolean; skip?: RegExp; lit?: RegExp; shell?: boolean }
const SINKS: Sink[] = [
  {kind: "sql", call: /(?:^|[^\w$])(?:executeQuery|executeUpdate|execute|executemany|query|raw|createQuery|createNativeQuery|prepareStatement|exec_driver_sql)\s*\(/g},
  {kind: "sql", call: /\.(?:prepareCall|addBatch|batchUpdate|queryFor\w+)\s*\(/g, lang: JAVA},
  {kind: "command", call: /(?:\bos\.(?:system|popen)|child_process\.(?:exec|execSync)|getRuntime\(\)\.exec|(?:^|[^\w$.])(?:exec|execSync|system|popen))\s*\(/g},
  {kind: "command", call: /\bsubprocess\.(?:run|call|Popen|check_output|check_call)\s*\(/g, when: /shell\s*=\s*[Tt]rue/},
  {kind: "command", call: /(?:\.exec|\.command|\bnew\s+ProcessBuilder)\s*\(/g, lang: JAVA, all: true},
  {kind: "code", call: /(?:(?:^|[^\w$.])(?:eval|Function)|\bnew\s+Function)\s*\(/g},
  {kind: "path", call: /(?:\b(?:readFile|readFileSync|createReadStream|sendFile|unlink|unlinkSync)|\bFiles\.(?:readAllBytes|readString|newInputStream|lines|delete)|\bnew\s+(?:File|FileInputStream)|(?:^|[^\w$.])open)\s*\(/g},
  {kind: "path", call: /(?:\bnew\s+(?:java\.io\.)?(?:File|FileInputStream|FileOutputStream|FileReader|FileWriter|RandomAccessFile)|\b(?:java\.nio\.file\.)?(?:Paths\.get|Path\.of))\s*\(/g, lang: JAVA, all: true},
  {kind: "ssrf", call: /(?:(?:^|[^\w$.])(?:fetch|urlopen)|\baxios(?:\.(?:get|post|put|request))?|\brequests\.(?:get|post|put|request)|\bhttps?\.get|\bgetForObject|\bgetForEntity)\s*\(/g},
  {kind: "xss", call: /(?:\.(?:innerHTML|outerHTML)\s*\+?=|\bdocument\.write\s*\()/g},
  {kind: "xss", call: /\b(?:getWriter|getOutputStream)\(\)\.(?:print|println|write|format|printf|append)\s*\(/g, lang: JAVA, all: true},
  {kind: "ldap", call: /\.search\s*\(/g, lang: JAVA, all: true, scope: /\b(?:Initial)?(?:Ldap|Dir)Context\b/},
  {kind: "xpath", call: /\.(?:evaluate|compile)\s*\(/g, lang: JAVA, scope: /\bXPath\b/},
  {kind: "trust-boundary", call: /(?:\bgetSession\([^)]*\)|\b\w*[sS]ession)\.(?:setAttribute|putValue)\s*\(/g, lang: JAVA, all: true},
  {kind: "code", call: /(?:^|[^\w$.])exec\s*\(/g, lang: PY},
  {kind: "command", call: /\b(?:subprocess\.(?:getoutput|getstatusoutput)|os\.(?:exec\w+|spawn\w+))\s*\(/g, lang: PY, all: true},
  {kind: "deserialization", call: /\b(?:c?[pP]ickle|_pickle|marshal|dill|cloudpickle|jsonpickle|shelve)\.(?:loads?|decode|open|Unpickler)\s*\(|\byaml\.(?:unsafe_load|unsafe_load_all|full_load|load_all|load)\s*\(/g, lang: PY, unless: /Loader\s*=\s*(?:yaml\.)?C?SafeLoader\b/},
  {kind: "redirect", call: /(?:^|[^\w$.]|\bflask\.)(?:redirect|HttpResponseRedirect|HttpResponsePermanentRedirect|RedirectResponse)\s*\(/g, lang: PY},
  {kind: "xxe", call: /\b(?:parseString|parse|fromstring|XML|iterparse|feed)\s*\(/g, lang: PY, all: true, scope: /\bfeature_external_ges\s*,\s*(?:true|1)\b|\bresolve_entities\s*=\s*(?:true|1)\b/i},
  {kind: "ldap", call: /\.(?:search|search_s|search_st|search_ext|search_ext_s|paged_search)\s*\(/g, lang: PY, all: true, scope: /\bldap3?\b/},
  {kind: "xpath", call: /(?:\.xpath|\bXPath|\bETXPath)\s*\(/g, lang: PY},
  {kind: "xpath", call: /\belementpath\.(?:select|iter_select|Selector)\s*\(/g, lang: PY, arg: 1},
  {kind: "path", call: /\b(?:codecs\.open|io\.open|os\.path\.(?:exists|lexists|isfile|isdir|getsize|getmtime)|os\.(?:remove|unlink|listdir|scandir|stat|makedirs|mkdir|rmdir|rename|replace|chmod)|shutil\.\w+|send_file|FileResponse)\s*\(/g, lang: PY},
  // JavaScript / TypeScript: MongoDB $where runs JavaScript on the server; vm is not a sandbox; writes; Express redirects.
  {kind: "nosql", call: /\.(?:find|findOne|findOneAndUpdate|findOneAndDelete|update|updateOne|updateMany|deleteOne|deleteMany|remove|count|countDocuments|aggregate)\s*\(/g, lang: JS, when: /\$where\b/},
  {kind: "code", call: /\bvm\.(?:runIn(?:New|This)?Context|compileFunction)\s*\(|\bnew\s+vm\.Script\s*\(|(?:^|[^\w$.])(?:safeEval|notevil)\s*\(/g, lang: JS},
  {kind: "path", call: /\b(?:createWriteStream|writeFile|writeFileSync|appendFile|appendFileSync)\s*\(/g, lang: JS},
  {kind: "redirect", call: /\bres\.redirect\s*\(/g, lang: JS, all: true},
  // PHP
  {kind: "sql", call: /\b(?:mysqli_query|mysql_query|mysqli_multi_query|mysqli_real_query|pg_query|sqlite_query|odbc_exec|db2_exec)\s*\(/g, lang: PHP, all: true},
  {kind: "command", call: /(?:^|[^\w$>:])(?:shell_exec|passthru|proc_open|pcntl_exec)\s*\(/g, lang: PHP},
  {kind: "code", call: /(?:^|[^\w$>:])(?:assert|create_function)\s*\(/g, lang: PHP, all: true},
  {kind: "path", call: /(?:^|[^\w$>:])(?:include|include_once|require|require_once)\b\s*\(?/g, lang: PHP},
  {kind: "path", call: /(?:^|[^\w$>:])(?:file_get_contents|file_put_contents|fopen|readfile|file|unlink|copy|rename|opendir|scandir|highlight_file|show_source|parse_ini_file)\s*\(/g, lang: PHP},
  {kind: "ssrf", call: /\bcurl_init\s*\(/g, lang: PHP},
  {kind: "xss", call: /(?:^|[^\w$>:])(?:echo|print)\b\s*\(?/g, lang: PHP, all: true},
  {kind: "redirect", call: /\bheader\s*\(/g, lang: PHP, lit: /^\s*location\s*:/i},
  {kind: "deserialization", call: /\bunserialize\s*\(/g, lang: PHP},
  {kind: "ldap", call: /\bldap_search\s*\(/g, lang: PHP, arg: 2},
  // Go
  {kind: "sql", call: /\.(?:Query|QueryRow|Exec|Prepare|Raw)\s*\(/g, lang: GO},
  {kind: "sql", call: /\.(?:QueryContext|QueryRowContext|ExecContext|PrepareContext)\s*\(/g, lang: GO, arg: 1},
  {kind: "command", call: /\bexec\.Command\s*\(/g, lang: GO, shell: true},
  {kind: "path", call: /\b(?:os\.(?:Open|OpenFile|ReadFile|Create|Remove|RemoveAll|WriteFile|ReadDir|Mkdir|MkdirAll)|ioutil\.(?:ReadFile|WriteFile|ReadDir))\s*\(/g, lang: GO},
  {kind: "path", call: /\bhttp\.ServeFile\s*\(/g, lang: GO, arg: 2},
  {kind: "ssrf", call: /\bhttp\.(?:Get|Post|Head|PostForm)\s*\(/g, lang: GO},
  {kind: "ssrf", call: /\bhttp\.NewRequest\s*\(/g, lang: GO, arg: 1},
  {kind: "redirect", call: /\bhttp\.Redirect\s*\(/g, lang: GO, arg: 2},
  {kind: "xss", call: /\btemplate\.(?:HTML|JS|HTMLAttr|URL)\s*\(|\bw\.Write\s*\(/g, lang: GO},
  {kind: "xss", call: /\b(?:fmt\.Fprint(?:f|ln)?|io\.WriteString)\s*\(\s*w\s*,/g, lang: GO, all: true},
  // C#
  {kind: "sql", call: /\bnew\s+(?:Sql|SqlCe|Sqlite|SQLite|MySql|Npgsql|OleDb|Odbc|Oracle)(?:Command|DataAdapter)\s*\(|\.CommandText\s*=(?!=)/g, lang: CS},
  {kind: "sql", call: /\.(?:ExecuteSqlRaw|ExecuteSqlCommand|FromSqlRaw|SqlQuery|ExecuteQuery|ExecuteCommand)\s*\(/g, lang: CS},
  {kind: "command", call: /\bProcess\.Start\s*\(|\bnew\s+ProcessStartInfo\s*\(/g, lang: CS, all: true},
  {kind: "command", call: /\.(?:FileName|Arguments)\s*=(?!=)/g, lang: CS, scope: /\bProcessStartInfo\b/},
  {kind: "path", call: /\b(?:File\.(?:ReadAllText|ReadAllBytes|ReadAllLines|ReadLines|OpenRead|OpenText|OpenWrite|Open|Delete|WriteAllText|WriteAllBytes|Copy|Move|AppendAllText|Create)|Directory\.(?:GetFiles|Delete|CreateDirectory|EnumerateFiles)|new\s+(?:FileStream|StreamReader|StreamWriter|FileInfo|DirectoryInfo)|Response\.(?:WriteFile|TransmitFile)|PhysicalFile)\s*\(/g, lang: CS},
  {kind: "xss", call: /\bResponse\.Write\s*\(|\bnew\s+HtmlString\s*\(|\bHtml\.Raw\s*\(|\.InnerHtml\s*\+?=(?!=)|\blbl\w*\.Text\s*\+?=(?!=)/g, lang: CS},
  {kind: "redirect", call: /\b(?:Response\.)?Redirect(?:Permanent)?\s*\(/g, lang: CS},
  {kind: "ldap", call: /\bnew\s+DirectorySearcher\s*\(|\.Filter\s*=(?!=)/g, lang: CS, scope: /\bDirectorySearcher\b/},
  {kind: "xpath", call: /\.(?:SelectNodes|SelectSingleNode)\s*\(/g, lang: CS},
  {kind: "deserialization", call: /\.Deserialize\s*\(/g, lang: CS, scope: /\b(?:BinaryFormatter|LosFormatter|SoapFormatter|NetDataContractSerializer|ObjectStateFormatter)\b|TypeNameHandling\.(?:All|Objects|Auto|Arrays)\b/},
  // Ruby (Rails): a hash or an array with placeholders is a bound condition, not SQL text.
  {kind: "sql", call: /\.(?:where|not|find_by_sql|count_by_sql|find_by|order|reorder|group|having|joins|pluck|select|from|exists\?|delete_all|update_all|calculate|exec_query|select_all|select_one|select_value|select_rows)\s*\(/g, lang: RB, skip: /^\s*(?:\w+:\s|:\w+\s*=>|\{|\[)/},
  {kind: "command", call: /(?:^|[^\w$.:])(?:system|exec|spawn)\b(?:\s*\(|\s+(?=[\w@$:"\x27\[]))|\b(?:IO\.popen|Open3\.(?:capture2e?|capture3|popen2e?|popen3)|Kernel\.(?:system|exec|spawn))(?:\s*\(|\s+(?=[\w@$:"\x27\[]))|%x[({[]|`/g, lang: RB},
  {kind: "code", call: /(?:^|[^\w$.:])(?:eval|instance_eval|class_eval|module_eval)\b(?:\s*\(|\s+(?=[\w@$:"\x27\[]))|\.(?:send|public_send|__send__)\s*\(/g, lang: RB},
  {kind: "code", call: /\.(?:constantize|safe_constantize)\b/g, lang: RB, recv: true},
  {kind: "deserialization", call: /\b(?:Marshal\.(?:load|restore)|YAML\.(?:load|unsafe_load|load_documents)|Psych\.(?:load|unsafe_load)|Oj\.load)\s*\(/g, lang: RB},
  {kind: "redirect", call: /\bredirect_to\b(?:\s*\(|\s+(?=[\w@$:"\x27\[]))/g, lang: RB},
  {kind: "path", call: /\b(?:File\.(?:read|open|new|readlines|binread|write|delete|unlink)|IO\.(?:read|readlines|binread)|FileUtils\.\w+)\s*\(|\bsend_file\b(?:\s*\(|\s+(?=[\w@$:"\x27\[]))/g, lang: RB},
  {kind: "xss", call: /\.html_safe\b/g, lang: RB, recv: true},
  {kind: "xss", call: /(?:^|[^\w$.:])raw\b(?:\s*\(|\s+(?=[\w@$:"\x27\[]))|\brender\s*\(?\s*(?:inline|html):/g, lang: RB}
];
/** Request input per language, beyond the shared SOURCE; scope limits a source to files that use a library (zip entries). */
const LANG_SOURCES: {lang: RegExp; re: RegExp; scope?: RegExp}[] = [
  {lang: PHP, re: /\$_(?:GET|POST|REQUEST|COOKIE|FILES)\b/},
  {lang: GO, re: /\.(?:FormValue|PostFormValue|FormFile)\s*\(|\.URL\.(?:Query\s*\(|RawQuery\b)|\b(?:r|req|request)\.(?:Form|PostForm|Header\.Get\s*\(|Cookie\s*\()|\bmux\.Vars\s*\(|\.ByName\s*\(|\bc\.(?:Query|DefaultQuery|PostForm|Param|GetHeader|Cookie)\s*\(/},
  {lang: CS, re: /\bRequest\s*(?:\.\s*(?:QueryString|Form|Params|Query|Cookies|Headers|ServerVariables|RouteValues|Files))?\s*\[|\bRequest\.(?:QueryString|Form|Params|Query|Cookies|Headers|Files|InputStream|Body|RawUrl)\b|\b(?:txt|tb)[A-Z]\w*\.Text\b/},
  {lang: RB, re: /\bparams\b(?:\s*\[|\.(?:require|fetch|permit|to_unsafe_h|dig|values_at)\b)|\bcookies\s*\[|\brequest\.(?:env|raw_post_data|body|query_string|referer|user_agent|query_parameters|request_parameters)\b/},
  // Zip Slip: an archive entry's name is attacker-chosen.
  {lang: JS, re: /\bentry\.(?:path|entryName|fileName)\b/, scope: /\b(?:unzipper|adm-zip|AdmZip|yauzl|decompress|jszip|JSZip)\b/}
];
/** The per-language source pattern for a file, or undefined. */
function langSource(path: string, text: string): RegExp | undefined {
  const all = LANG_SOURCES.filter(s => s.lang.test(path) && (!s.scope || s.scope.test(text)));
  return all.length ? new RegExp(all.map(s => s.re.source).join("|")) : undefined;
}
const hasSource = (path: string, text: string) => SOURCE.test(text) || !!langSource(path, text)?.test(text);
/** Path objects carry the path they were built from; their file methods are path sinks (Path(base) / name). */
const PATH_METHOD = /\b([A-Za-z_]\w*)\.(?:exists|is_file|is_dir|read_text|read_bytes|write_text|write_bytes|open|unlink|touch|mkdir|rmdir|stat|iterdir|rename|replace)\s*\(/g;
/** A command list run without a shell is only a shell command when it starts a shell (["sh", "-c", ...]). */
const SHELL = /^(?:(?:\/(?:usr\/)?bin\/)?(?:ba|z|da|k)?sh|cmd(?:\.exe)?|powershell(?:\.exe)?|pwsh)$/i;
/** Common method names that are not followed into same-named project functions on an untyped Python receiver. */
const PY_BUILTIN = /^(?:get|set|read|write|join|split|format|append|pop|items|keys|values|update|encode|decode|strip|replace|lower|upper|open|close|execute|run|find|search|match|load|loads|dump|dumps|copy|add|remove|insert|extend|index|count|sort|parse|send|call|__\w+__)$/;
// Request accessors, including wrapper/helper getters such as getRequestParameter or getCustomHeader (init parameters are trusted config).
const SOURCE = /\b(?:req|request)\.(?:query|params|body|headers|cookies|args|form|values|json|GET|POST|FILES|data|query_string|get_json|get_data|files|stream|COOKIES|META)\b|\b(?:get(?!Init)\w*?(?:Parameter|Header|Cookie)s?(?:Values|Map|Names)?|getQueryString)\s*\(/;
/** Output encoders only neutralise markup; the value stays dangerous for queries, commands, paths and sessions. */
const HTML_ESCAPE = /\b(?:escapeHtml\w*|escapeXml\w*|htmlEscape\w*|encodeForHTML\w*|encodeForXML\w*|encodeForJavaScript|escapeEcmaScript|(?:html|markupsafe|cgi|xml\.sax\.saxutils)\.escape|escape_\w*html\w*|html_escape\w*|htmlspecialchars|htmlentities|strip_tags|HtmlEncode|HtmlAttributeEncode|JavaScriptStringEncode|HTMLEscapeString|EscapeString|JSEscapeString|ERB::Util\.h)\s*\(/;
const SANITIZER = /\b(?:parseInt|parseFloat|Number|Integer\.parseInt|Long\.parseLong|int|float|bool|escape\w*|encodeURIComponent|encodeFor\w*|htmlEscape\w*|sanitize\w*|quote|basename|UUID\.fromString|isValid\w*|validate\w*|clean\w*|intval|floatval|boolval|ctype_digit|is_numeric|filter_var|\w+_escape_string|escapeshellarg|Atoi|ParseInt|ParseFloat|ParseBool|QueryEscape|PathEscape|(?:int|long|Guid|decimal|double)\.(?:Try)?Parse|Convert\.ToInt\d*|Path\.GetFileName|Integer|Float|sanitize_sql\w*|md5|sha1|crc32|hash_hmac)\s*\(|\.to_(?:i|f|sym)\b/;
const ANNOTATED = /@(?:RequestParam|PathVariable|RequestBody|RequestHeader|CookieValue|QueryParam|PathParam|FormParam|HeaderParam)\b|\[\s*From(?:Query|Body|Form|Route|Header)\b/;
const ROUTE = /^\s*@\w+(?:\.\w+)*\.(?:route|get|post|put|delete|patch)\s*\(/;
const ASSIGN = /^\s*((?:(?:const|let|var|final|val|auto|static)\s+)*(?:[\w$.]+(?:\s*<[^=]*>)?(?:\s*\[\s*\])*\s+)?)([A-Za-z_$][\w$]*)\s*(\+?=|\.=|:=|\|\|=)(?!=)\s*([\s\S]+)$/;
/** Go and Ruby multiple assignment (rows, err := db.Query(q)): the first name takes the value. */
const MULTI = /^\s*(?:var\s+)?([A-Za-z_$][\w$]*)\s*,\s*[A-Za-z_$][\w$]*(?:\s*,\s*[A-Za-z_$][\w$]*)*\s*:?=(?!=)\s*([\s\S]+)$/;
/** A Go function or method head: func (r *T) Name(args) (results) {. */
const GO_DECL = /^\s*func\s+(?:\([^)]*\)\s*)?[A-Za-z_]\w*\s*\([^)]*\)\s*(?:\([^)]*\)|[\w.*[\]]+)?\s*\{/;
const PY_MUTATOR = /^(?:append|extend|insert|pop|update|setdefault|write|writelines|add|set)$/;
const MUTATOR = /^(?:add|addAll|addElement|addFirst|addLast|append|insert|offer|push|put|putAll|putIfAbsent|set|setProperty|remove|clear|merge|compute\w*)$/;
const CONTAINER = /^new\s+[\w$.]*(?:List|Map|Set|Vector|Stack|Queue|Deque)\s*(?:<[^()]*>)?\s*\(\s*\)$/;
const MAX_FILES = 3000;
/** API types whose methods are the sinks; a typed receiver of any other type (a project class, an executor, an HTTP client) is not the sink. */
const RECEIVER: Partial<Record<SinkKind, RegExp>> = {
  sql: /^(?:Statement|PreparedStatement|CallableStatement|Connection|\w*Jdbc\w*|EntityManager|\w*Session|Query|TypedQuery|NativeQuery|SQLiteDatabase|DSLContext|Handle|DatabaseClient)$/,
  command: /^(?:Runtime|ProcessBuilder)$/,
  ldap: /^(?:\w*DirContext|\w*LdapContext|LdapTemplate|LdapOperations)$/,
  xpath: /^(?:XPath|XPathExpression)$/,
  "trust-boundary": /^\w*Session$/
};
/** A method or constructor head (Java, C#, Kotlin, JS/TS functions); calls end with ";" and control statements are excluded. */
const DECL = /^\s*(?:@[\w.]+(?:\([^)]*\))?\s+)*(?:(?:public|private|protected|static|final|abstract|synchronized|native|default|override|async|internal|open|suspend)\s+)*(?:fun\s+|function\s*\*?\s*|func\s+|(?!(?:return|new|else|throw|await|yield|case|typeof|delete|if|for|while|switch|catch)\b)[\w$.]+(?:<[^()]*>)?(?:\[\s*\])*\s+)(?!(?:if|for|while|switch|catch|synchronized)\b)[A-Za-z_$][\w$]*\s*\([^;]*\)\s*(?:throws\s+[\w$.,\s]+?)?(?::\s*[\w$.<>[\]?, ]+)?\s*\{/;

/** Code with comments removed and plain string contents replaced by "@n" (n indexes lits); template literals and f-strings keep their interpolations.
 * Interpolating strings (PHP "$id", Ruby "#{id}", C# $"{id}") become the literal followed by their interpolated expressions. */
function code(line: string, lits: string[], path = ""): string {
  const php = PHP.test(path), rb = RB.test(path), cs = CS.test(path);
  const out = line.replace(/(?<![fF\w])"(?:[^"\x5c]|\x5c.)*"|(?<![fF\w])'(?:[^'\x5c]|\x5c.)*'/g, (s, at: number) => {
    const body = s.slice(1, -1), lit = "\"@" + (lits.push(body) - 1) + "\"";
    // Quotes inside a JS template literal (`id = '${id}'`) are text, so the interpolations still count.
    if (!php && !rb && (line.slice(0, at).match(/(?<!\x5c)`/g)?.length ?? 0) % 2 === 1)
      return lit + [...body.matchAll(/\$\{([^}]*)\}/g)].map(m => " + (" + m[1] + ")").join("");
    if (s[0] !== "\"") return lit;
    const parts = php ? [...body.matchAll(/\{?(\$[A-Za-z_]\w*(?:->\w+|\[[^\]]*\])*)\}?/g)].map(m => m[1])
      : rb ? [...body.matchAll(/#\{([^}]*)\}/g)].map(m => m[1])
      : cs && /\$@?$|\$$/.test(line.slice(Math.max(0, at - 2), at)) ? [...body.matchAll(/(?<!\{)\{([^{}:]+)(?::[^{}]*)?\}/g)].map(m => m[1]) : [];
    return lit + parts.map(p => " + (" + p + ")").join("");
  }).replace(/\/\/.*$|(?:^|\s)#.*$/, "");
  return rb ? out.replace(/(?<![\w@])@@?(?=[A-Za-z_])/g, "") : out;
}

/** Index of the bracket closing the one at open, or text.length. */
function closing(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if ("([{".includes(text[i])) depth++;
    else if (")]}".includes(text[i]) && --depth === 0) return i;
  }
  return text.length;
}

/** Top-level comma-separated arguments from the "(" at open until the matching ")" or end of text. */
function splitArgs(text: string, open: number): string[] {
  const args: string[] = [];
  let depth = 0, current = "";
  for (let i = open + 1; i < text.length; i++) {
    const ch = text[i];
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) { if (depth === 0) break; depth--; }
    else if (ch === "," && depth === 0) { args.push(current); current = ""; continue; }
    current += ch;
  }
  if (current.trim() || args.length) args.push(current);
  return args;
}

/** Parts of text split at top-level (outside brackets) occurrences of sep. */
function topLevelSplit(text: string, sep: string): string[] {
  const parts: string[] = [];
  let level = 0, last = 0;
  for (let i = 0; i < text.length; i++) {
    if ("([{".includes(text[i])) level++;
    else if (")]}".includes(text[i])) level--;
    else if (level === 0 && text.startsWith(sep, i)) { parts.push(text.slice(last, i)); last = i + sep.length; i += sep.length - 1; }
  }
  parts.push(text.slice(last));
  return parts;
}

const depth = (text: string) => (text.match(/[([]/g)?.length ?? 0) - (text.match(/[)\]]/g)?.length ?? 0);

/** Statements: physical lines joined while brackets are open or an operator continues them, then split at top-level ";". */
function statements(lines: readonly string[], lits: string[], path = ""): {text: string; index: number; end: number}[] {
  const out: {text: string; index: number; end: number}[] = [];
  for (let i = 0; i < lines.length; i++) {
    const index = i;
    let text = code(lines[i], lits, path);
    while (i + 1 < lines.length && i - index < 12 && !/[{};]\s*$/.test(text) &&
      (depth(text) > 0 || /(?:[=+,?([]|&&|\|\|)\s*$/.test(text) || /^\s*(?:\.(?!\.)|\+(?!\+)|\?|:(?!:)|&&|\|\|)/.test(lines[i + 1]))) text += " " + code(lines[++i], lits, path);
    let level = 0, start = 0;
    for (let k = 0; k < text.length; k++) {
      if ("([".includes(text[k])) level++;
      else if (")]".includes(text[k])) level--;
      else if (text[k] === ";" && level <= 0) { out.push({text: text.slice(start, k), index, end: i}); start = k + 1; }
    }
    if (text.slice(start).trim() || start === 0) out.push({text: text.slice(start), index, end: i});
  }
  return out;
}

type Value = number | string | boolean;
/** Value of a constant arithmetic/comparison expression over known constants, or undefined. */
function evaluate(expr: string, consts: ReadonlyMap<string, Value>, lits: readonly string[] = []): Value | undefined {
  const tokens = expr.match(/"@\d+"|\d+|[A-Za-z_$][\w$]*|[<>!=]=|&&|\|\||\S/g) ?? [];
  let i = 0;
  const num = (v: Value): number => { if (typeof v !== "number") throw 0; return v; };
  const prim = (): Value => {
    const t = tokens[i++];
    if (t === "(") { const v = or(); if (tokens[i++] !== ")") throw 0; return v; }
    if (t === "-") return -num(prim());
    if (t === "!") { const v = prim(); if (typeof v !== "boolean") throw 0; return !v; }
    if (/^\d+$/.test(t ?? "")) return Number(t);
    if (t === "true" || t === "false") return t === "true";
    const lit = /^"@(\d+)"$/.exec(t ?? "");
    if (lit && lits[+lit[1]] !== undefined) return lits[+lit[1]];
    const c = consts.get(t);
    if (typeof c === "number" || typeof c === "boolean" || (typeof c === "string" && lits.length)) return c;
    throw 0;
  };
  const level = (next: () => Value, ops: string[], apply: (op: string, a: Value, b: Value) => Value) => (): Value => {
    let v = next();
    while (ops.includes(tokens[i])) { const op = tokens[i++]; v = apply(op, v, next()); }
    return v;
  };
  const mul = level(prim, ["*", "/", "%"], (op, a, b) => {
    const x = num(a), y = num(b);
    if (op !== "*" && y === 0) throw 0;
    return op === "*" ? x * y : op === "/" ? Math.trunc(x / y) : x % y;
  });
  const add = level(mul, ["+", "-"], (op, a, b) => op === "+" && typeof a === "string" && typeof b === "string" ? a + b : op === "+" ? num(a) + num(b) : num(a) - num(b));
  const cmp = level(add, ["<", ">", "<=", ">="], (op, a, b) => op === "<" ? num(a) < num(b) : op === ">" ? num(a) > num(b) : op === "<=" ? num(a) <= num(b) : num(a) >= num(b));
  // Python membership on constant strings: "x" in s, "x" notin s.
  const member = level(cmp, ["in", "notin"], (op, a, b) => { if (typeof a !== "string" || typeof b !== "string") throw 0; return b.includes(a) === (op === "in"); });
  const eq = level(member, ["==", "!="], (op, a, b) => op === "==" ? a === b : a !== b);
  const and = level(eq, ["&&"], (_, a, b) => a === true && b === true);
  const or: () => Value = level(and, ["||"], (_, a, b) => a === true || b === true);
  try { const v = or(); return i === tokens.length ? v : undefined; } catch { return undefined; }
}

interface Param { name: string; annotated: boolean }
function params(snippet: string, path: string): Param[] {
  const go = GO.test(path), receiver = go ? /^\s*func\s*\([^)]*\)\s*\w+\s*\(/.exec(snippet) : null;
  const open = receiver ? receiver[0].length - 1 : snippet.indexOf("(");
  if (open < 0) return [];
  return splitArgs(snippet, open).map(part => {
    const annotated = ANNOTATED.test(part);
    const bare = part.replace(/@\w+(?:\([^)]*\))?|\[\s*\w+(?:\([^)]*\))?\s*\]\s*(?=\w)/g, "").replace(/=[\s\S]*$/, "").replace(/^\s*(?:\.\.\.|\*\*|\*)/, "").trim();
    if (/^[{[]/.test(bare)) return {name: "", annotated};
    const name = bare.includes(":") ? bare.split(":")[0].trim() : go ? (/^([A-Za-z_]\w*)/.exec(bare)?.[1] ?? "") : (/([A-Za-z_]\w*)\s*$/.exec(bare)?.[1] ?? "");
    return {name, annotated};
  }).filter(p => p.name !== "self" && p.name !== "cls");
}

interface Reach { kind: SinkKind; path: string; line: number; via: string[] }
/** returns: parameters whose taint is returned; markup: the subset still returned without HTML encoding. */
interface Summary { path: string; sinks: Map<number, Reach>; returns: Set<number>; markup: Set<number>; source: boolean; markupSource?: boolean; cls?: string; arity?: number; varargs?: boolean }
type Site = ReturnType<JavaProject["resolve"]>;
type Summaries = Map<string, Summary[]>;
const FAMILY: [RegExp, string][] = [[/\.(?:java|kt|scala|groovy)$/i, "jvm"], [/\.(?:[cm]?js|jsx|tsx?)$/i, "js"], [/\.py$/i, "py"], [/\.cs$/i, "cs"], [/\.php$/i, "php"], [/\.go$/i, "go"], [/\.rb$/i, "rb"], [/\.rs$/i, "rs"]];
const family = (path: string) => FAMILY.find(([re]) => re.test(path))?.[1] ?? path;
/** Summaries for a called name; a definition in the calling file shadows same-named ones elsewhere.
 * Without types a call is matched by name only, so other languages never match, and a name defined
 * in more than two other files (execute, run, handle) is too ambiguous to follow; a name of 15+ characters may have up to six implementations. A parsed Java call site narrows the
 * candidates to overloads taking its argument count and, when its receiver type is known, to that type's hierarchy. */
function lookup(summaries: Summaries, name: string, path: string, site?: Site, project?: JavaProject): Summary[] {
  let all = summaries.get(name) ?? [];
  if (site) {
    all = all.filter(s => s.arity === undefined || [...site.argc].some(n => n === s.arity || (s.varargs && n >= s.arity! - 1)));
    const classes = site.types && project?.related(site.types);
    if (classes) all = all.filter(s => s.cls === undefined || classes.has(s.cls));
  }
  const own = all.filter(s => s.path === path);
  if (own.length) return own;
  const lang = family(path), same = all.filter(s => family(s.path) === lang);
  // A long, specific name (GetSecurityQuestionAndAnswer) is an interface method with a few implementations, not a common verb.
  return new Set(same.map(s => s.path)).size > (name.length >= 15 ? 6 : 2) ? [] : same;
}

interface Fn { name: string; path: string; startLine: number; lines: string[]; params: Param[]; route: boolean; summary: Summary; skipHead: boolean }
/** Functions from a syntax tree: only the body is analysed (the head is blanked), so a method named like a sink is not its own sink. */
function treeFunctions(path: string, text: string, methods: readonly {name: string; cls: string; startLine: number; endLine: number; body: [number, number, number, number]; params: Param[]; varargs?: boolean}[], java: boolean): Fn[] {
  const all = text.split(/\r?\n/);
  return methods.map(m => {
    const [openLine, openColumn, closeLine, closeColumn] = m.body;
    const lines = all.slice(m.startLine - 1, m.endLine).map((line, k) => {
      const row = m.startLine - 1 + k;
      if (row === closeLine) line = line.slice(0, closeColumn + 1);
      return row < openLine ? "" : row === openLine ? " ".repeat(openColumn) + line.slice(openColumn) : line;
    });
    return {m, lines};
  }).map(({m, lines}) => ({name: m.name, path, startLine: m.startLine, lines, params: m.params, skipHead: false,
    route: all.slice(Math.max(0, m.startLine - 4), m.startLine - 1).some(l => ROUTE.test(l)),
    summary: {path, sinks: new Map(), returns: new Set(), markup: new Set(), source: false, ...java ? {cls: m.cls, arity: m.params.length, varargs: m.varargs} : {}}}));
}

function functions(file: TaintFile): Fn[] {
  const all = file.text.split(/\r?\n/);
  const fns: Fn[] = [];
  for (const name of definedNames(file.text)) {
    const snippet = definitionSnippet(file.text, name, 300);
    if (!snippet) continue;
    const head = snippet.text.split("\n")[0];
    // Multi-line calls ("new String(", "x = foo(") look like declarations; a definition has a body.
    if (new RegExp("(?:\\bnew\\s+|[=.]\\s*)" + name + "\\s*\\(").test(head) || (BRACES.test(file.path) && !/\{/.test(snippet.text.split(";")[0]))) continue;
    const above = all.slice(Math.max(0, snippet.startLine - 4), snippet.startLine - 1);
    fns.push({name, path: file.path, startLine: snippet.startLine, skipHead: true, lines: snippet.text.split("\n"), params: params(snippet.text, file.path),
      route: above.some(l => ROUTE.test(l)), summary: {path: file.path, sinks: new Map(), returns: new Set(), markup: new Set(), source: false}});
  }
  return fns;
}

interface Hit extends Reach { origin: number }
interface Ctx { kind: "plain" | "cond" | "dead" | "switch"; value?: Value; live?: boolean; matched?: boolean }
interface Slots { list?: (number | undefined)[]; keys: Map<string, number | undefined>; depth: number; config?: boolean }
const PY_CONTAINER = /^(?:\{\s*\}|\[\s*\]|dict\(\s*\)|list\(\s*\)|(?:configparser\.)?(?:Raw|Safe)?ConfigParser\(\s*\))$/;
/** Flask/Django responses whose first argument (or first tuple element) is the body; headers and status are not markup. */
const RESPONSE_CALL = /^(?:[\w.]*\.)?(?:make_response|Response|HttpResponse)\s*\(/;
const NOT_MARKUP = /^(?:[\w.]*\.)?(?:redirect|jsonify|send_file|send_from_directory|abort|url_for|render_template|JsonResponse|HttpResponseRedirect|FileResponse)\s*\(/;
const ALL_KINDS: SinkKind[] = ["sql", "nosql", "command", "code", "path", "ssrf", "xss", "ldap", "xpath", "trust-boundary", "redirect", "xxe", "deserialization"];

/** Sink kinds an anchored validation regex rules out: none when it admits arbitrary text, fewer when it allows quotes, dots or slashes. */
function regexKinds(source: string): SinkKind[] {
  const anchored = /^\^|^\\A/.test(source) && /(?:\$|\\z|\\Z)$/.test(source);
  if (!anchored || /(?<!\\)\.[*+?{]|\[\^|\x5c[SWD]|(?<![\x5c[])\.(?![^\[]*\])/.test(source)) return [];
  return ALL_KINDS.filter(k => !(k === "path" && /[./]|\\\./.test(source)) && !(["sql", "xpath", "ldap", "nosql", "code"].includes(k) && /['"\x5c]/.test(source.replace(/\x5c[dws.\-]/g, "")))
    && !(k === "xss" && /[<>]/.test(source)) && !(k === "command" && /[;&|$`]/.test(source.slice(0, -1))));
}

/** The variable a validating predicate checks and the sink kinds it then rules out ("is_numeric($id)", "allowed.includes(x)", "/^\d+$/.test(x)"). */
function validatesFor(pred: string, lits: readonly string[]): {name: string; kinds: SinkKind[]} | undefined {
  const p = pred.trim().replace(/^\((.*)\)$/s, "$1").trim(), v = "([A-Za-z_$][\\w$]*)";
  const lit = (m: string) => { const at = /^"@(\d+)"$/.exec(m.trim()); return at ? lits[+at[1]] : undefined; };
  let m = new RegExp("^(?:is_numeric|is_int|is_integer|is_float|ctype_digit|ctype_alnum|ctype_alpha|ctype_xdigit|Number\\.isInteger|Number\\.isSafeInteger|Number\\.isFinite|(?:StringUtils|NumberUtils)\\.is(?:Numeric|Alphanumeric|Alpha|Digits|CreatableNumber)|validator\\.is(?:Int|Numeric|Alphanumeric|Alpha|UUID|MongoId|Hexadecimal|Boolean)|(?:int|long|short|byte|uint|ulong|decimal|double|float|Guid|bool)\\.TryParse)\\s*\\(\\s*" + v + "\\b").exec(p);
  if (m) return {name: m[1], kinds: ALL_KINDS};
  m = new RegExp("^filter_var\\s*\\(\\s*" + v + "\\s*,\\s*FILTER_VALIDATE_(?:INT|FLOAT|BOOLEAN?|IP)\\b").exec(p);
  if (m) return {name: m[1], kinds: ALL_KINDS};
  m = new RegExp("^(?:in_array\\s*\\(\\s*" + v + "\\s*,|[A-Za-z_$][\\w$.]*\\.(?:includes|contains|Contains|has|containsKey|ContainsKey|include\\?)\\s*\\(\\s*" + v + "\\s*\\)$)").exec(p);
  if (m && !/^"@/.test(p)) return {name: m[1] ?? m[2], kinds: ALL_KINDS};
  m = new RegExp("^(?:preg_match\\s*\\(\\s*(\"@\\d+\")\\s*,\\s*" + v + "|(?:Pattern\\.matches|Regex\\.IsMatch)\\s*\\(\\s*(?:(\"@\\d+\")\\s*,\\s*" + v + "|" + v + "\\s*,\\s*(\"@\\d+\"))|" + v + "\\.matches\\s*\\(\\s*(\"@\\d+\")\\s*\\))").exec(p);
  if (m) {
    const source = lit(m[1] ?? m[3] ?? m[6] ?? m[8] ?? "") ?? "", name = m[2] ?? m[4] ?? m[5] ?? m[7];
    // preg_match patterns carry delimiters and flags (/^\d+$/i); Java's matches() is always anchored.
    const body = m[1] ? source.replace(/^(.)(.*)\1[a-zA-Z]*$/s, "$2") : m[8] ? "^" + source.replace(/^\^?/, "").replace(/\$?$/, "") + "$" : source;
    const kinds = regexKinds(body);
    return kinds.length ? {name, kinds} : undefined;
  }
  m = new RegExp("^/(.+)/[a-z]*\\.test\\s*\\(\\s*" + v + "\\s*\\)$").exec(p);
  if (m) { const kinds = regexKinds(m[1]); return kinds.length ? {name: m[2], kinds} : undefined; }
  return undefined;
}

/** Follows tainted variables through one body; returns every sink reached (directly or through summarised calls) and whether taint is returned. */
function analyse(lines: readonly string[], firstLine: number, path: string, initial: ReadonlyMap<string, number>, summaries: Summaries, skipFirst: boolean, project?: JavaProject, isRoute = false): {hits: Hit[]; returned?: number; markup?: number} {
  const tainted = new Map(initial), htmlSafe = new Set<string>(), writers = new Set<string>(), consts = new Map<string, Value>(), slots = new Map<string, Slots>();
  const lits: string[] = [], hits: Hit[] = [], stack: Ctx[] = [], ifs = new Map<number, boolean | undefined>();
  const py = PY.test(path), go = GO.test(path), rb = RB.test(path), body = lines.join("\n"), braces = py || BRACES.test(path), extra = langSource(path, body);
  const declOf = go ? GO_DECL : DECL;
  // Python only: kinds a variable was validated for by a guard, the tainted variables each one was derived from, names assigned so far.
  const safeFor = new Map<string, Set<SinkKind>>(), derived = new Map<string, string[]>(), seen = new Set<string>(), lists = new Map<string, string[]>();
  // Brace languages: variables an if guard proved safe, valid while the block the guard covers (ctx; undefined is the whole body) is open.
  const guarded = new Map<string, {ctx?: Ctx; kinds: Set<SinkKind>}>();
  let returned: number | undefined, markup: number | undefined, pending: Ctx | undefined, span = [0, 0], index = 0, route = isRoute;
  const isGuarded = (word: string, kind?: SinkKind) => {
    const g = guarded.get(word);
    return !!g && (g.ctx === undefined || stack.includes(g.ctx)) && (g.kinds.size === ALL_KINDS.length || (kind !== undefined && g.kinds.has(kind)));
  };
  /** Records what an if condition proves: every &&-ed check inside the block (into), or after an exiting block every ||-ed negated check. */
  const guard = (cond: string, into: Ctx | undefined, negated: boolean) => {
    const parts = topLevelSplit(cond, negated ? "||" : "&&");
    if (parts.some(p => topLevelSplit(p, negated ? "&&" : "||").length > 1)) return;
    for (const part of parts) {
      let p = part.trim().replace(/^\((.*)\)$/s, "$1").trim();
      if (negated) { const not = /^!\s*([\s\S]+)$/.exec(p) ?? /^([\s\S]+?)\s*===?\s*false$/.exec(p); if (!not) continue; p = not[1]; }
      const v = validatesFor(p, lits);
      if (v && tainted.has(v.name)) guarded.set(v.name, {ctx: into, kinds: new Set(v.kinds)});
    }
  };
  /** Whether the if block starting with rest (or, when it only opens a brace, on the next lines) always leaves: return, throw, die, exit. */
  const exits = (rest: string): boolean => {
    const EXIT = /^\s*(?:return|throw|exit|die|continue|break)\b/;
    const r = rest.trim().replace(/^\{/, "").trim();
    if (r) return EXIT.test(r) || /;\s*(?:return|throw|exit|die)\b[^}]*\}?\s*$/.test(r);
    for (let i = span[1] - firstLine + 1, depth = 0; i < lines.length && i <= span[1] - firstLine + 6; i++) {
      const l = lines[i].trim();
      if (/^\}/.test(l) && depth === 0) return false;
      if (depth === 0 && EXIT.test(l)) return true;
      for (const ch of l) depth += ch === "{" ? 1 : ch === "}" ? -1 : 0;
    }
    return false;
  };
  /** Syntax-tree view of the calls of name in the current statement (Java only). */
  const site = (name: string): Site => project?.resolve(path, name, span[0], span[1]);
  const live = () => stack.every(c => c.kind !== "dead" && (c.kind !== "switch" || c.live));
  /** Whether an update may not happen: a conditional block was entered since the variable's block (from). */
  const weak = (from = 0) => stack.slice(from).some(c => c.kind === "cond" || (c.kind === "switch" && c.value === undefined));
  const constant = (expr: string): Value | undefined => {
    const e = expr.trim().replace(/^\((?:int|long|short|char|String)\)\s*/, "");
    const lit = /^"@(\d+)"$/.exec(e);
    if (lit) return lits[+lit[1]];
    if (/^[A-Za-z_$][\w$]*$/.test(e) && consts.has(e)) return consts.get(e);
    const at = /^([A-Za-z_$][\w$]*)\.charAt\(\s*(\d+)\s*\)$/.exec(e), s = at && consts.get(at[1]);
    if (at) return typeof s === "string" && +at[2] < s.length ? s[+at[2]] : undefined;
    const item = py ? /^([A-Za-z_]\w*)\[\s*(-?\d+)\s*\]$/.exec(e) : null, str = item && consts.get(item[1]);
    if (item) return typeof str === "string" && str.at(+item[2]) !== undefined ? str.at(+item[2]) : undefined;
    return evaluate(e, consts, py ? lits : undefined);
  };
  /** cond ? a : b with a constant condition becomes the taken branch. */
  const ternary = (expr: string): string => {
    let level = 0, q = -1, nested = 0;
    for (let i = 0; i < expr.length; i++) {
      const ch = expr[i];
      if ("([{".includes(ch)) level++;
      else if (")]}".includes(ch)) level--;
      else if (level === 0 && ch === "?" && !/[?.]/.test(expr[i + 1] ?? "") && expr[i - 1] !== "?") { if (q < 0) q = i; else nested++; }
      else if (level === 0 && ch === ":" && q >= 0 && expr[i + 1] !== ":" && nested-- === 0) {
        const v = constant(expr.slice(0, q));
        return v === true ? ternary(expr.slice(q + 1, i)) : v === false ? ternary(expr.slice(i + 1)) : expr;
      }
    }
    return expr;
  };
  /** The two arms of a top-level cond ? a : b whose condition is not constant (not Python). */
  const arms = (expr: string): [string, string] | undefined => {
    if (py) return undefined;
    let level = 0, q = -1, nested = 0;
    for (let i = 0; i < expr.length; i++) {
      const ch = expr[i];
      if ("([{".includes(ch)) level++;
      else if (")]}".includes(ch)) level--;
      else if (level === 0 && ch === "?" && !/[?.]/.test(expr[i + 1] ?? "") && expr[i - 1] !== "?") { if (q < 0) q = i; else nested++; }
      else if (level === 0 && ch === ":" && q >= 0 && expr[i + 1] !== ":" && expr[i - 1] !== ":" && nested-- === 0) return [expr.slice(q + 1, i), expr.slice(i + 1)];
    }
    return undefined;
  };
  /** The body argument of make_response(...)/Response(...): the first argument, or the first element of a tuple argument. */
  const body1 = (text: string, open: number): string => {
    const first = splitArgs(text, open)[0] ?? "";
    return first.trim().startsWith("(") ? splitArgs(first.trim(), 0)[0] ?? "" : first;
  };
  const origin = (input: string, line: number, kind?: SinkKind): number | undefined => {
    let expr = ternary(input), found: number | undefined;
    const both = arms(expr);
    // Either arm may be the value: a sanitised arm does not clean the other one.
    if (both) return origin(both[0], line, kind) ?? origin(both[1], line, kind);
    const xss = kind === "xss";
    if ((xss && HTML_ESCAPE.test(expr)) || (!HTML_ESCAPE.test(expr) && SANITIZER.test(expr))) return undefined;
    if (SOURCE.test(expr) || extra?.test(expr)) return line;
    // XPath has no escape sequence: a value with its quote character replaced cannot leave a quoted XPath literal.
    if (py && kind === "xpath") expr = expr.replace(/\b[A-Za-z_]\w*(?:\.\w+)*\.replace\(\s*"@(\d+)"\s*,\s*"@(\d+)"\s*\)/g, (m, a: string, b: string) => {
      const q = lits[+a].replace(/\\/g, "");
      return (q === "'" || q === "\"") && !lits[+b].includes(q) ? "\"\"" : m;
    });
    // Reads of tracked collection slots and calls of analysed functions only carry what actually flows through them.
    expr = expr.replace(/\b([A-Za-z_$][\w$]*)\.get\(\s*("@\d+"|\d+)\s*\)/g, (m, name: string, key: string) => {
      const s = slots.get(name);
      if (!s) return m;
      found ??= /^\d/.test(key) ? s.list?.[+key] : s.keys.get(lits[+key.slice(2, -1)]);
      return "\"\"";
    });
    if (py) expr = expr.replace(/\b([A-Za-z_]\w*)(?:\[\s*("@\d+"|-?\d+)\s*\]|\.get\(\s*("@\d+")\s*,\s*("@\d+"|[^()]*?)\s*\))/g, (m, name: string, key?: string, a?: string, b?: string) => {
      const s = slots.get(name);
      if (!s) return m;
      if (key !== undefined) found ??= /^"/.test(key) ? s.keys.get(lits[+key.slice(2, -1)]) : s.list?.at(+key);
      else if (s.config && /^"@\d+"$/.test(b!)) found ??= s.keys.get(lits[+a!.slice(2, -1)] + "\0" + lits[+b!.slice(2, -1)]);
      else found ??= s.keys.get(lits[+a!.slice(2, -1)]) ?? origin(b!, line, kind);
      return "\"\"";
    });
    const callee = py ? /(?:(?<=\.)|(?<![\w$.]))([A-Za-z_$][\w$]*)\s*\(/g : /(?:\bthis\.|\bself\.|\bnew\s+[\w$.]+\s*\([^()]*\)\s*\.|\b[A-Z][\w$]*\.|(?<![\w$.]))([A-Za-z_$][\w$]*)\s*\(/g;
    for (let guard = 0; guard < 20; guard++) {
      const call = [...expr.matchAll(callee)]
        .find(m => summaries.has(m[1]) && !/^(?:new|if|for|while|switch|return|catch)$/.test(m[1]) && !(py && expr[m.index! - 1] === "." && PY_BUILTIN.test(m[1])));
      if (!call) break;
      const open = call.index! + call[0].length - 1, args = splitArgs(expr, open);
      for (const s of lookup(summaries, call[1], path, site(call[1]), project)) {
        if (xss ? s.markupSource : s.source) found ??= line;
        for (const i of xss ? s.markup : s.returns) if (args[i] !== undefined) found ??= origin(args[i], line, kind);
      }
      expr = expr.slice(0, call.index) + "\"\"" + expr.slice(closing(expr, open) + 1);
    }
    if (found !== undefined) return found;
    for (const word of expr.match(/[A-Za-z_$][\w$]*/g) ?? []) if (tainted.has(word) && !(xss && htmlSafe.has(word)) && !(kind && safeFor.get(word)?.has(kind)) && !isGuarded(word, kind)) return tainted.get(word);
    return undefined;
  };
  const assign = (name: string, op: string, input: string, line: number, isWeak: boolean) => {
    // A response's headers are not its body: make_response((body, {"X-Header": value})).
    const response = py ? RESPONSE_CALL.exec(input.trim()) : null, rhs = response ? body1(input.trim(), response[0].length - 1) : input;
    const from = origin(rhs, line), value = op === "=" && !isWeak ? constant(ternary(rhs)) : undefined;
    if (op === "=") guarded.delete(name);
    if (value !== undefined) consts.set(name, value); else consts.delete(name);
    const container = op === "=" && !isWeak && (CONTAINER.test(rhs.trim()) || (py && PY_CONTAINER.test(rhs.trim())));
    if (container) slots.set(name, {list: [], keys: new Map(), depth: stack.length, config: /ConfigParser/.test(rhs)}); else if (op === "=" || from !== undefined) slots.delete(name);
    if (py) {
      const kinds = new Set<SinkKind>([...safeFor.values()].flatMap(k => [...k]));
      if (/\.replace\(/.test(rhs)) kinds.add("xpath");
      const safe = from === undefined ? [] : [...kinds].filter(k => origin(rhs, line, k) === undefined);
      if (safe.length && (op === "=" || safeFor.has(name))) safeFor.set(name, new Set(safe)); else if (op === "=" || from !== undefined) safeFor.delete(name);
      derived.set(name, (rhs.match(/[A-Za-z_]\w*/g) ?? []).filter(w => tainted.has(w) && w !== name));
      if (op === "=") { if (/^\s*\[/.test(rhs)) lists.set(name, [...rhs.matchAll(/"@(\d+)"/g)].map(l => lits[+l[1]])); else lists.delete(name); }
      seen.add(name);
    }
    if (/\b(?:getWriter|getOutputStream)\(\)\s*$/.test(rhs)) writers.add(name); else if (op === "=") writers.delete(name);
    const strong = op === "=" && !isWeak, keep = strong || !tainted.has(name) || htmlSafe.has(name);
    if (from !== undefined && keep && origin(rhs, line, "xss") === undefined) htmlSafe.add(name); else if (from !== undefined || strong) htmlSafe.delete(name);
    if (from !== undefined) tainted.set(name, from);
    else if (strong) tainted.delete(name);
    // A value built only from constants or guard-validated variables, assigned inside a conditional block, holds until that block closes.
    // Sanitizer calls do not count: escaping is kind-specific and the old taint comes back after the block.
    else if (op === "=" && !py && tainted.has(name) && stack.length && (rhs.match(/[A-Za-z_$][\w$]*/g) ?? []).every(w => !tainted.has(w) || isGuarded(w))) guarded.set(name, {ctx: stack[stack.length - 1], kinds: new Set(ALL_KINDS)});
  };
  /** A value stored into a container taints it; the container stays HTML-safe only while everything stored was escaped. */
  const store = (name: string, from: number | undefined, value: string, line: number) => {
    if (from === undefined) return;
    if (origin(value, line, "xss") !== undefined) htmlSafe.delete(name); else if (!tainted.has(name)) htmlSafe.add(name);
    tainted.set(name, from);
  };
  const mutate = (name: string, method: string, args: string[], line: number, isWeak: boolean) => {
    const from = origin(args.join(","), line), s = slots.get(name);
    if (py && lists.has(name)) lists.get(name)!.push(...args.flatMap(a => [...a.matchAll(/"@(\d+)"/g)].map(l => lits[+l[1]])));
    if (s) isWeak = weak(s.depth);
    if (s && !isWeak && (method === "add" || (py && method === "append")) && args.length === 1 && s.list) s.list.push(origin(args[0], line));
    else if (s && !isWeak && py && method === "pop" && args.length <= 1 && /^\s*-?\d*\s*$/.test(args[0] ?? "") && s.list) { s.list.splice(args[0]?.trim() ? +args[0] : -1, 1); return; }
    else if (s && !isWeak && py && method === "insert" && args.length === 2 && /^\s*\d+\s*$/.test(args[0]) && s.list) s.list.splice(+args[0], 0, origin(args[1], line));
    else if (s && !isWeak && s.config && method === "set" && args.length === 3 && args.slice(0, 2).every(a => /^\s*"@\d+"\s*$/.test(a))) s.keys.set(lits[+args[0].trim().slice(2, -1)] + "\0" + lits[+args[1].trim().slice(2, -1)], origin(args[2], line));
    else if (s && !isWeak && method === "put" && args.length === 2 && /^\s*"@\d+"\s*$/.test(args[0])) s.keys.set(lits[+args[0].trim().slice(2, -1)], origin(args[1], line));
    else if (s && !isWeak && method === "remove" && /^\s*\d+\s*$/.test(args[0] ?? "") && s.list) s.list.splice(+args[0], 1);
    else if (s && !isWeak && method === "clear") slots.set(name, {list: [], keys: new Map(), depth: s.depth});
    else slots.delete(name);
    store(name, from, args.join(","), line);
  };
  const sinks = (input: string, line: number) => {
    // A writer kept in a variable (out = response.getWriter()) is the same sink as the inline call.
    const text = writers.size ? input.replace(new RegExp("(?<![\\w$.])(?:" + [...writers].join("|") + ")\\.(?=(?:print|println|write|format|printf|append)\\s*\\()", "g"), "getWriter().") : input;
    for (const sink of SINKS) {
      if ((sink.lang && !sink.lang.test(path)) || (sink.when && !sink.when.test(text)) || (sink.unless && sink.unless.test(text)) || (sink.scope && !sink.scope.test(body))) continue;
      for (const m of text.matchAll(sink.call)) {
        // Python's exec runs code, not a command.
        if (py && sink.kind === "command" && /(?:^|[^\w$.])exec\s*\($/.test(m[0])) continue;
        // Database handles are objects (stmt.execute, cursor.execute); Helper.execute(...) is a static call into application code.
        // Go package-level handles are exported names (DB.Query), so the heuristic does not apply there.
        if (sink.kind === "sql" && !go && !rb && /(?<![\w$.])[A-Z][\w$]*\.$/.test(text.slice(0, m.index! + 1))) continue;
        const method = /(?<!\bnew\s+)\b([A-Za-z_$][\w$]*)\s*\($/.exec(m[0])?.[1], types = method && RECEIVER[sink.kind] ? site(method)?.types : undefined;
        if (types && project && ![...types].some(t => [...project.ancestors(t)].some(a => RECEIVER[sink.kind]!.test(a)))) continue;
        // A Go prepared statement (stmt, err := db.Prepare(q)) takes bind values, not SQL.
        if (go && sink.kind === "sql") {
          const recv = /([A-Za-z_]\w*)\.$/.exec(text.slice(0, m.index! + 1))?.[1];
          if (recv && new RegExp("\\b" + recv + "\\s*(?:,\\s*\\w+\\s*)?:?=\\s*[\\w.]+\\.Prepare(?:Context)?\\s*\\(").test(body)) continue;
        }
        const end = m.index! + m[0].length, args = m[0].endsWith("(") ? splitArgs(text, end - 1) : [text.slice(end)];
        const first = (args[0] ?? "").trim(), shell = sink.shell && /^"@\d+"$/.test(first) && SHELL.test(lits[+first.slice(2, -1)] ?? "");
        const arg = sink.recv ? text.slice(0, m.index).replace(/^\s*[A-Za-z_$][\w$]*\s*(?:\|\|)?=(?!=)/, "") : sink.all || shell ? args.join(",") : args[sink.arg ?? 0] ?? "";
        if (sink.skip?.test(arg)) continue;
        const lit = /"@(\d+)"/.exec(arg);
        if (sink.lit && !(lit && sink.lit.test(lits[+lit[1]] ?? ""))) continue;
        if (sink.kind === "redirect" && /^\s*(?:[\w.]*\.)?url_for\s*\(/.test(arg)) continue;
        const from = origin(arg, line, sink.kind);
        if (from !== undefined) hits.push({kind: sink.kind, path, line, via: [], origin: from});
      }
    }
    if (!py) return;
    // subprocess with an argument list runs no shell, unless the list itself starts one: ["sh", "-c", command].
    for (const m of text.matchAll(/\bsubprocess\.(?:run|call|Popen|check_output|check_call)\s*\(/g)) {
      const args = splitArgs(text, m.index! + m[0].length - 1), first = (args[0] ?? "").trim();
      if (/\bshell\s*=\s*true\b/.test(text)) continue;
      const list = /^[A-Za-z_]\w*$/.test(first) ? lists.get(first) ?? [] : [...first.matchAll(/"@(\d+)"/g)].map(l => lits[+l[1]]);
      const from = list.some(l => SHELL.test(l.trim().split(/\s+/)[0] ?? "")) ? origin(first, line, "command") : undefined;
      if (from !== undefined) hits.push({kind: "command", path, line, via: [], origin: from});
    }
    for (const m of text.matchAll(PATH_METHOD)) {
      const from = /\bpathlib\b|\bPath\s*\(/.test(body) ? origin(m[1], line, "path") : undefined;
      if (from !== undefined) hits.push({kind: "path", path, line, via: [], origin: from});
    }
    // Flask sessions are signed cookies the application trusts: session[key] = value.
    const session = /^\s*(?:[\w.]+\.)?session\s*\[([^\]]*)\]\s*=(?!=)([\s\S]+)$|^\s*(?:[\w.]+\.)?session\.(?:update|setdefault)\s*\(([\s\S]*)\)\s*$/.exec(text);
    const into = session && origin(session[3] ?? session[1] + "," + session[2], line, "trust-boundary");
    if (into !== undefined && into !== null) hits.push({kind: "trust-boundary", path, line, via: [], origin: into});
  };
  const calls = (text: string, line: number) => {
    for (const m of text.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) {
      if (/\b(?:function|def|fun|func)\s+$/.test(text.slice(0, m.index))) continue;
      const args = splitArgs(text, m.index! + m[0].length - 1);
      for (const s of lookup(summaries, m[1], path, site(m[1]), project)) for (const [i, reach] of s.sinks) {
        const from = args[i] === undefined ? undefined : origin(args[i], line, reach.kind);
        if (from !== undefined) hits.push({...reach, via: [m[1], ...reach.via], origin: from});
      }
    }
  };
  /** After a Python guard "if C: return", C is false: what each "or"-ed part of C rejects tells which sinks the variables it tests are now safe for. */
  const validate = (cond: string) => {
    const parts = topLevelSplit(cond, "||");
    if (parts.some(p => topLevelSplit(p, "&&").length > 1)) return;
    const quotes = new Set<string>();
    for (const part of parts) {
      const p = part.trim(), kinds = new Set<SinkKind>();
      const has = /^"@(\d+)"\s+in\s+([\s\S]+)$/.exec(p);
      if (has) {
        const lit = lits[+has[1]] ?? "";
        if (/\.\.|[\\/]/.test(lit)) kinds.add("path");
        if (/['"]/.test(lit)) for (const k of ["sql", "xpath", "ldap"] as const) kinds.add(k);
        if (/[<>]/.test(lit)) kinds.add("xss");
        if (/[;&|$`]/.test(lit)) kinds.add("command");
        if (/[()*]/.test(lit)) kinds.add("ldap");
      } else if (/^!\s*[\s\S]*\.(?:startswith|endswith)\s*\(/.test(p)) {
        const q = /\.(startswith|endswith)\s*\(\s*"@(\d+)"\s*\)\s*$/.exec(p);
        if (q && /^\\?['"]$/.test(lits[+q[2]] ?? "")) quotes.add(q[1]); else kinds.add("path");
      } else if (/\.(?:netloc|hostname|scheme|host)\s*(?:!=|notin|==)/.test(p)) { kinds.add("redirect"); kinds.add("ssrf"); }
      else if (/^[\s\S]+\snotin\s/.test(p) || /^!\s*(?:re\.)?(?:fullmatch|match)\s*\(/.test(p) || /^!\s*[\w.]+\.is(?:alnum|alpha|digit|decimal|numeric|identifier)\s*\(\s*\)$/.test(p)) ALL_KINDS.forEach(k => kinds.add(k));
      if (!kinds.size) continue;
      for (const word of p.match(/[A-Za-z_]\w*/g) ?? []) {
        if (!tainted.has(word)) continue;
        for (const name of [word, ...(derived.get(word) ?? [])]) safeFor.set(name, new Set([...safeFor.get(name) ?? [], ...kinds]));
      }
    }
    // A value that must start and end with a quote and holds no other one is a string literal: safe to evaluate as code.
    if (quotes.size === 2) for (const word of cond.match(/[A-Za-z_]\w*/g) ?? []) if (tainted.has(word)) safeFor.set(word, new Set([...safeFor.get(word) ?? [], "code"]));
  };
  const enter = (ctx: Ctx, rest: string, line: number, first: boolean) => {
    const r = rest.trim();
    if (!r) { pending = ctx; return; }
    stack.push(ctx);
    if (r.startsWith("{")) step(r.slice(1), line, first);
    else { step(r, line, first); stack.pop(); }
  };
  const step = (input: string, line: number, first: boolean): void => {
    let text = input;
    if (braces) while (/^\s*\}/.test(text)) { stack.pop(); text = text.replace(/^\s*\}/, ""); }
    if (!text.trim()) return;
    if (pending) { const ctx = pending; pending = undefined; return enter(ctx, text, line, first); }
    const top = stack[stack.length - 1], label = /^\s*(?:case\s+([^:]+?)|default)\s*:(?!:)([\s\S]*)$/.exec(text);
    if (braces && label && top?.kind === "switch" && stack.slice(0, -1).every(c => c.kind !== "dead")) {
      if (top.value !== undefined) {
        // A Python case may list alternatives: case "C" | "D".
        const vs = label[1] === undefined ? [] : (py ? topLevelSplit(label[1], "|") : [label[1]]).map(constant);
        const hit = label[1] === undefined ? !top.matched : vs.some(v => v === undefined || v === top.value);
        if (hit) top.live = top.matched = true;
      }
      return step(label[2], line, first);
    }
    if (!live()) {
      if (braces) for (const ch of text) if (ch === "{") stack.push({kind: "dead"}); else if (ch === "}") stack.pop();
      return;
    }
    if (braces && top?.kind === "switch" && top.value !== undefined && /^\s*(?:break|return|throw|continue)\b/.test(text)) top.live = false;
    // Whole-file passes meet every method in turn: locals of one method must not taint a same-named variable or parameter of the next.
    // A function's own head (int execute(Connection c)) names it; it is not a call of the sink with that name.
    if (first && !braces && /^\s*(?:async\s+)?(?:def|fn|func|function)\b/.test(text)) return;
    const head = first && braces ? declOf.exec(text) : null;
    if (head) {
      stack.push({kind: "plain"});
      const rest = text.slice(head[0].length);
      return rest.trim() ? step(rest, line, first) : undefined;
    }
    const decl = braces && !first && initial.size === 0 ? declOf.exec(text) : null;
    // Ruby has no braces: a def starts the next method in a whole-file pass.
    if (rb && /^\s*def\s/.test(text)) {
      if (!first && initial.size === 0) { tainted.clear(); htmlSafe.clear(); consts.clear(); slots.clear(); }
      return;
    }
    if (decl) {
      tainted.clear(); htmlSafe.clear(); writers.clear(); consts.clear(); slots.clear(); safeFor.clear(); derived.clear(); seen.clear(); lists.clear(); guarded.clear();
      route = py && lines.slice(Math.max(0, index - 3), index).some(l => ROUTE.test(l));
      stack.push({kind: "plain"});
      const rest = text.slice(decl[0].length);
      return rest.trim() ? step(rest, line, first) : undefined;
    }
    const header = braces ? /^\s*(?:(else\s+if|if|for|while|switch|catch|synchronized)\s*\(|(else|do|try|finally)\b)/.exec(text) : null;
    if (header) {
      const d = stack.length;
      if (header[2]) {
        const prev = ifs.get(d);
        const kind = header[2] !== "else" ? "plain" : prev === true ? "dead" : prev === false ? "plain" : "cond";
        return enter({kind}, text.slice(header.index + header[0].length), line, first);
      }
      const open = header[0].length - 1, close = closing(text, open), cond = text.slice(open + 1, close);
      if (!first) { sinks(text.slice(0, close + 1), line); calls(text.slice(0, close + 1), line); } else sinks(text.slice(0, close + 1), line);
      const rest = text.slice(close + 1);
      if (header[1] === "switch") return enter({kind: "switch", value: constant(cond), live: constant(cond) === undefined, matched: false}, rest, line, first);
      if (header[1] === "for") {
        const each = /([A-Za-z_$][\w$]*)\s*(?::|\s+of\s+|\s+in\s+)([^;]+)$/.exec(cond);
        if (each && !first) assign(each[1], "=", each[2], line, true);
      }
      if (header[1] !== "if" && header[1] !== "else if") return enter({kind: "cond"}, rest, line, first);
      const prev = header[1] === "if" ? false : ifs.get(d), v = prev === true ? undefined : constant(cond);
      const kind = prev === true || v === false ? "dead" : v === true && prev === false ? "plain" : "cond";
      ifs.set(d, prev === true || v === true ? true : prev === false && v === false ? false : undefined);
      const ctx: Ctx = {kind};
      if (!first && !py && kind === "cond") {
        if (header[1] === "if" && exits(rest)) guard(cond, stack[stack.length - 1], true);
        else guard(cond, ctx, false);
      }
      return enter(ctx, rest, line, first);
    }
    if (py) {
      const check = /^\s*__validated__\(([\s\S]*)\)\s*$/.exec(text);
      if (check) { if (!first) validate(check[1]); return; }
    }
    sinks(text, line);
    if (!first) {
      calls(text, line);
      const isWeak = weak();
      const ret = /^\s*return\b([\s\S]*)$/.exec(text), destructure = /^\s*(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(.+)$/.exec(text);
      const multi = !py ? MULTI.exec(text) : null, assignment = multi ? null : ASSIGN.exec(text), mutation = /^\s*([A-Za-z_$][\w$]*)\.(\w+)\s*\(/.exec(text), element = /^\s*([A-Za-z_$][\w$]*)\s*\[[^\]]*\]\s*=(?!=)([\s\S]+)$/.exec(text);
      // Python: nothing after a return or raise in the same block runs.
      if (py && /^\s*(?:return|throw)\b/.test(text) && stack.length && stack[stack.length - 1].kind !== "switch") stack[stack.length - 1] = {kind: "dead"};
      if (ret && ret[1].trim()) {
        // What a Flask view returns is the response body, served as HTML.
        const value = ret[1].trim(), response = RESPONSE_CALL.exec(value);
        returned ??= origin(ret[1], line);
        if (!(py && NOT_MARKUP.test(value))) markup ??= origin(response && py ? body1(value, response[0].length - 1) : ret[1], line, "xss");
        const shown = py && route && !NOT_MARKUP.test(value) ? origin(response ? body1(value, response[0].length - 1) : value, line, "xss") : undefined;
        if (shown !== undefined) hits.push({kind: "xss", path, line, via: [], origin: shown});
      }
      else if (destructure) {
        const from = origin(destructure[2], line);
        if (from !== undefined) for (const name of destructure[1].split(",")) { const n = name.split(":").pop()!.trim(); if (n) tainted.set(n, from); }
      } else if (multi) assign(multi[1], "=", multi[2], line, isWeak);
      else if (assignment) assign(assignment[2], assignment[3] === ":=" ? "=" : assignment[3] === "+=" || assignment[3] === "=" ? assignment[3] : "+=", assignment[4], line, isWeak && !assignment[1].trim() && !(py && !seen.has(assignment[2])));
      else if (mutation && (MUTATOR.test(mutation[2]) || (py && PY_MUTATOR.test(mutation[2])))) mutate(mutation[1], mutation[2], splitArgs(text, mutation.index + mutation[0].length - 1), line, isWeak);
      else if (element) {
        const from = origin(element[2], line), s = py ? slots.get(element[1]) : undefined, key = /^\s*[A-Za-z_]\w*\s*\[\s*("@\d+"|\d+)\s*\]/.exec(text)?.[1];
        if (s && key && !weak(s.depth)) { if (key.startsWith("\"")) s.keys.set(lits[+key.slice(2, -1)], from); else if (s.list) s.list[+key] = from; }
        else if (s) slots.delete(element[1]);
        store(element[1], from, element[2], line);
      }
    }
    if (braces) {
      let level = 0;
      for (const ch of text) if (ch === "{") { stack.push({kind: "plain"}); level++; } else if (ch === "}" && level-- > 0) stack.pop(); else if (ch === "}") stack.pop();
    }
  };
  for (const s of statements(lines, lits, path)) { span = [firstLine + s.index, firstLine + s.end]; index = s.index; step(s.text, firstLine + s.index, skipFirst && s.index === 0); }
  return {hits, returned, markup};
}

/** A Python module that handles web requests: its request-to-sink flows are fully covered by taint analysis. */
export const pythonHandler = (path: string, text: string): boolean => PY.test(path) && (SOURCE.test(text) || text.split(/\r?\n/).some(l => ROUTE.test(l)));

/** Syntax trees of recently scanned files by path and content hash, so a repeated scan reparses only what changed. */
const parsed = new Map<string, JavaFile | SyntaxFile>();
let parsedSize = 0;
function cachedParse<T extends JavaFile | SyntaxFile>(path: string, text: string, parse: () => T | undefined): T | undefined {
  const key = path + "\0" + createHash("sha1").update(text).digest("hex"), hit = parsed.get(key);
  if (hit) { parsed.delete(key); parsed.set(key, hit); return hit as T; }
  const tree = parse();
  if (!tree) return undefined;
  parsed.set(key, tree);
  parsedSize += text.length;
  // About 64 MB of source; the oldest entries go first.
  for (const [k, v] of parsed) { if (parsedSize <= 64_000_000) break; parsed.delete(k); parsedSize -= v.text.length; }
  return tree;
}

export function taintFlows(files: readonly TaintFile[]): TaintFlow[] {
  // Minified bundles (vendor libraries) define short, common names that would capture calls from the application's own code.
  const minified = (f: TaintFile) => /\.min\.[cm]?js$/i.test(f.path) || (JS.test(f.path) && f.text.length > 2000 && f.text.length / (f.text.split("\n").length) > 300);
  const sources = files.slice(0, MAX_FILES).filter(f => f.text.length <= 200_000 && !minified(f)).map(f => PY.test(f.path) ? {path: f.path, text: pythonToBraces(f.text)} : f);
  const trees = new Map<string, JavaFile>(), others = new Map<string, SyntaxFile>();
  for (const f of sources) {
    const tree = /\.java$/i.test(f.path) ? cachedParse("java:" + f.path, f.text, () => parseJava(f.text)) : undefined;
    if (tree) trees.set(f.path, tree);
    const other = tree || PY.test(f.path) ? undefined : cachedParse(f.path, f.text, () => parseSyntax(f.path, f.text));
    if (other) others.set(f.path, other);
  }
  const project = trees.size ? new JavaProject(trees) : undefined;
  // Parsed files are analysed with comments blanked out, so commented-out code is neither a source nor a sink.
  const text = (f: TaintFile) => trees.get(f.path)?.text ?? others.get(f.path)?.text ?? f.text;
  const fns = sources.flatMap(f => {
    const java = trees.get(f.path), other = others.get(f.path);
    if (java) return treeFunctions(f.path, java.text, java.methods, true);
    if (other) return treeFunctions(f.path, other.text, other.functions.map(m => ({...m, params: m.params.map(p => ({name: p.name, annotated: ANNOTATED.test(p.text)}))})), false);
    return functions(f);
  });
  const summaries: Summaries = new Map();
  for (const fn of fns) summaries.set(fn.name, [...(summaries.get(fn.name) ?? []), fn.summary]);
  for (let round = 0; round < 6; round++) {
    let changed = false;
    for (const fn of fns) {
      const s = fn.summary;
      if (!s.source || !s.markupSource) {
        const own = analyse(fn.lines, fn.startLine, fn.path, new Map(), summaries, fn.skipHead, project);
        if (!s.source && own.returned !== undefined) changed = s.source = true;
        if (!s.markupSource && own.markup !== undefined) changed = s.markupSource = true;
      }
      fn.params.forEach((p, i) => {
        if (!p.name || (s.sinks.has(i) && s.markup.has(i))) return;
        const result = analyse(fn.lines, fn.startLine, fn.path, new Map([[p.name, fn.startLine]]), summaries, fn.skipHead, project);
        const hit = result.hits.find(h => !h.via.includes(fn.name));
        if (hit && !s.sinks.has(i)) { s.sinks.set(i, {kind: hit.kind, path: hit.path, line: hit.line, via: hit.via}); changed = true; }
        if (result.returned !== undefined && !s.returns.has(i)) { s.returns.add(i); changed = true; }
        if (result.markup !== undefined && !s.markup.has(i)) { s.markup.add(i); changed = true; }
      });
    }
    if (!changed) break;
  }
  const flows = new Map<string, TaintFlow>();
  const add = (path: string, hits: Hit[]) => {
    for (const h of hits) {
      const key = h.kind + "|" + h.path + ":" + h.line;
      const flow = {kind: h.kind, source: {path, line: h.origin}, sink: {path: h.path, line: h.line}, via: h.via};
      const known = flows.get(key);
      if (!known || flow.via.length > known.via.length) flows.set(key, flow);
    }
  };
  for (const fn of fns) {
    const entry = fn.params.filter(p => p.name && (p.annotated || fn.route));
    // A Python route reads the request through globals or helpers, so it is an entry point even without parameters.
    if (entry.length || (fn.route && PY.test(fn.path))) add(fn.path, analyse(fn.lines, fn.startLine, fn.path, new Map(entry.map(p => [p.name, fn.startLine])), summaries, fn.skipHead, project, fn.route).hits);
  }
  for (const file of sources) if (hasSource(file.path, text(file))) add(file.path, analyse(text(file).split(/\r?\n/), 1, file.path, new Map(), summaries, false, project).hits);
  return [...flows.values()].sort((a, b) => a.sink.path.localeCompare(b.sink.path) || a.sink.line - b.sink.line);
}

const LABEL: Record<SinkKind, string> = {sql: "SQL injection", nosql: "NoSQL injection", command: "Command injection", code: "Code injection", path: "Path traversal", ssrf: "Server-side request forgery",
  xss: "Cross-site scripting", ldap: "LDAP injection", xpath: "XPath injection", "trust-boundary": "Trust boundary violation", redirect: "Open redirect",
  xxe: "XML external entity injection", deserialization: "Unsafe deserialization"};
export function flowTitle(flow: TaintFlow): string {
  return LABEL[flow.kind] + ": request input reaches this sink" + (flow.via.length ? " through " + flow.via.join(" → ") : "");
}
export const flowSeverity = (flow: TaintFlow): "high" | "medium" => ["sql", "nosql", "command", "code", "ldap", "xpath", "xxe", "deserialization"].includes(flow.kind) ? "high" : "medium";
