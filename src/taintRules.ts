import {readFile} from "node:fs/promises";
import {join} from "node:path";
import type {SinkKind} from "./taint";

/**
 * The taint engine's rule data: request sources, sinks, sanitizers and the API types that own a sink, per language.
 * taint.ts holds the analysis; adding a framework is usually a data change here.
 */
export const JAVA = /\.(?:java|kt)$/i;
export const PY = /\.py$/i;
export const JS = /\.(?:[cm]?js|jsx|tsx?)$/i;
export const GO = /\.go$/i;
export const CS = /\.cs$/i;
export const PHP = /\.php$/i;
export const RB = /\.rb$/i;
/** arg: which argument is the tainted one (default the first; all: any); unless: a statement that makes the call safe.
 * recv: the tainted value is the receiver before the call (value.constantize); skip: an argument shape that is safe (a Rails
 * hash condition); lit: the argument's first string literal must match (header("Location: " . $url)); shell: when the first
 * argument is a shell (exec.Command("sh", "-c", cmd)), every argument counts. */
export interface Sink { custom?: boolean; kind: SinkKind; call: RegExp; when?: RegExp; unless?: RegExp; lang?: RegExp; scope?: RegExp; all?: boolean; arg?: number; recv?: boolean; skip?: RegExp; lit?: RegExp; shell?: boolean }
const BASE_SINKS: Sink[] = [
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
const BASE_LANG_SOURCES: {lang: RegExp; re: RegExp; scope?: RegExp}[] = [
  {lang: PHP, re: /\$_(?:GET|POST|REQUEST|COOKIE|FILES)\b/},
  {lang: GO, re: /\.(?:FormValue|PostFormValue|FormFile)\s*\(|\.URL\.(?:Query\s*\(|RawQuery\b)|\b(?:r|req|request)\.(?:Form|PostForm|Header\.Get\s*\(|Cookie\s*\()|\bmux\.Vars\s*\(|\.ByName\s*\(|\bc\.(?:Query|DefaultQuery|PostForm|Param|GetHeader|Cookie)\s*\(/},
  {lang: CS, re: /\bRequest\s*(?:\.\s*(?:QueryString|Form|Params|Query|Cookies|Headers|ServerVariables|RouteValues|Files))?\s*\[|\bRequest\.(?:QueryString|Form|Params|Query|Cookies|Headers|Files|InputStream|Body|RawUrl)\b|\b(?:txt|tb)[A-Z]\w*\.Text\b/},
  {lang: RB, re: /\bparams\b(?:\s*\[|\.(?:require|fetch|permit|to_unsafe_h|dig|values_at)\b)|\bcookies\s*\[|\brequest\.(?:env|raw_post_data|body|query_string|referer|user_agent|query_parameters|request_parameters)\b/},
  // Zip Slip: an archive entry's name is attacker-chosen.
  {lang: JS, re: /\bentry\.(?:path|entryName|fileName)\b/, scope: /\b(?:unzipper|adm-zip|AdmZip|yauzl|decompress|jszip|JSZip)\b/}
];
// Request accessors, including wrapper/helper getters such as getRequestParameter or getCustomHeader (init parameters are trusted config).
export const SOURCE = /\b(?:req|request)\.(?:query|params|body|headers|cookies|args|form|values|json|GET|POST|FILES|data|query_string|get_json|get_data|files|stream|COOKIES|META)\b|\b(?:get(?!Init)\w*?(?:Parameter|Header|Cookie)s?(?:Values|Map|Names)?|getQueryString)\s*\(/;
/** Output encoders only neutralise markup; the value stays dangerous for queries, commands, paths and sessions. */
export const HTML_ESCAPE = /\b(?:escapeHtml\w*|escapeXml\w*|htmlEscape\w*|encodeForHTML\w*|encodeForXML\w*|encodeForJavaScript|escapeEcmaScript|(?:html|markupsafe|cgi|xml\.sax\.saxutils)\.escape|escape_\w*html\w*|html_escape\w*|htmlspecialchars|htmlentities|strip_tags|HtmlEncode|HtmlAttributeEncode|JavaScriptStringEncode|HTMLEscapeString|EscapeString|JSEscapeString|ERB::Util\.h)\s*\(/;
const BASE_SANITIZER = /\b(?:parseInt|parseFloat|Number|Integer\.parseInt|Long\.parseLong|int|float|bool|escape\w*|encodeURIComponent|encodeFor\w*|htmlEscape\w*|sanitize\w*|quote|basename|UUID\.fromString|isValid\w*|validate\w*|clean\w*|intval|floatval|boolval|ctype_digit|is_numeric|filter_var|\w+_escape_string|escapeshellarg|Atoi|ParseInt|ParseFloat|ParseBool|QueryEscape|PathEscape|(?:int|long|Guid|decimal|double)\.(?:Try)?Parse|Convert\.ToInt\d*|Path\.GetFileName|Integer|Float|sanitize_sql\w*|md5|sha1|crc32|hash_hmac)\s*\(|\.to_(?:i|f|sym)\b/;
export const ANNOTATED = /@(?:RequestParam|PathVariable|RequestBody|RequestHeader|CookieValue|QueryParam|PathParam|FormParam|HeaderParam)\b|\[\s*From(?:Query|Body|Form|Route|Header)\b/;
/** API types whose methods are the sinks; a typed receiver of any other type (a project class, an executor, an HTTP client) is not the sink. */
export const RECEIVER: Partial<Record<SinkKind, RegExp>> = {
  sql: /^(?:Statement|PreparedStatement|CallableStatement|Connection|\w*Jdbc\w*|EntityManager|\w*Session|Query|TypedQuery|NativeQuery|SQLiteDatabase|DSLContext|Handle|DatabaseClient)$/,
  command: /^(?:Runtime|ProcessBuilder)$/,
  ldap: /^(?:\w*DirContext|\w*LdapContext|LdapTemplate|LdapOperations)$/,
  xpath: /^(?:XPath|XPathExpression)$/,
  "trust-boundary": /^\w*Session$/
};
/** Database handle types of JS/TS drivers and ORMs (pg Pool/Client, mysql Connection, Knex, Sequelize, TypeORM, Prisma) and of Go
 * (database/sql, sqlx, gorm); a typed receiver of any other type (CommandBus, HttpService, redis.Client) is not a SQL sink. */
export const JS_SQL_RECEIVER = /^(?:Pool|PoolClient|Client|Connection|PoolConnection|Knex|Sequelize|DataSource|EntityManager|QueryRunner|Repository|Database|Db|Transaction|Prisma\w*|\w*(?:Sql|SQL|Pg|Postgres|Mysql|MySql|MySQL|Sqlite|SQLite|Mssql|Oracle|Db|DB|Database|Repository|Connection)\w*)$/;
export const GO_SQL_RECEIVER = /^(?:DB|Tx|Conn|Stmt|\w*(?:Sql|SQL|Db|DB|Repo|Repository|Store)\w*)$/;

export const SINK_KINDS: readonly SinkKind[] = ["sql", "nosql", "command", "code", "path", "ssrf", "xss", "ldap", "xpath", "trust-boundary", "redirect", "xxe", "deserialization"];
export let SINKS = BASE_SINKS;
export let LANG_SOURCES = BASE_LANG_SOURCES;
export let SANITIZER = BASE_SANITIZER;

/** A team's own sources, sinks and sanitizers (.hushavyr/taint-rules.json), compiled; added to the built-in rules. */
export interface TaintRules { sinks: Sink[]; sources: {lang: RegExp; re: RegExp}[]; sanitizer?: RegExp }
export const TAINT_RULES_FILE = join(".hushavyr", "taint-rules.json");

/** Use the built-in rules plus a team's own (none: built-in only). */
export function useTaintRules(rules?: TaintRules): void {
  SINKS = rules ? [...BASE_SINKS, ...rules.sinks] : BASE_SINKS;
  LANG_SOURCES = rules ? [...BASE_LANG_SOURCES, ...rules.sources] : BASE_LANG_SOURCES;
  SANITIZER = rules?.sanitizer ? new RegExp(BASE_SANITIZER.source + "|" + rules.sanitizer.source) : BASE_SANITIZER;
}

/**
 * Parse .hushavyr/taint-rules.json. Patterns are regular expressions matched against code with string literals blanked:
 * sources match the input expression, sinks and sanitizers the called name (the "(" is added). languages are file
 * extensions (default: all). Throws an Error naming the bad entry.
 */
export function parseTaintRules(text: string): TaintRules {
  let data: unknown;
  try { data = JSON.parse(text); } catch (e) { throw new Error(TAINT_RULES_FILE + ": " + (e as Error).message); }
  const fail = (where: string, what: string): never => { throw new Error(TAINT_RULES_FILE + ": " + where + " " + what); };
  if (!data || typeof data !== "object" || Array.isArray(data)) fail("top level", "must be an object with sources, sinks and sanitizers");
  const record = data as Record<string, unknown>;
  for (const key of Object.keys(record)) if (!["sources", "sinks", "sanitizers"].includes(key)) fail(key, "is not a known key (sources, sinks, sanitizers)");
  const list = (key: string): Record<string, unknown>[] => {
    const value = record[key] ?? [];
    if (!Array.isArray(value)) fail(key, "must be an array");
    return (value as unknown[]).map((v, i) => typeof v === "string" ? {pattern: v} : v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : fail(key + "[" + i + "]", "must be an object"));
  };
  const regex = (where: string, value: unknown): string => {
    if (typeof value !== "string" || !value.trim() || value.length > 500) fail(where, "must be a regular expression of 1-500 characters");
    try { new RegExp(value as string); } catch (e) { fail(where, "is not a valid regular expression: " + (e as Error).message); }
    return value as string;
  };
  const lang = (where: string, value: unknown): RegExp => {
    if (value === undefined) return /(?:)/;
    if (!Array.isArray(value) || !value.length || value.some(v => typeof v !== "string" || !/^\w+$/.test(v))) fail(where, "must be a list of file extensions such as [\"ts\", \"js\"]");
    return new RegExp("\\.(?:" + (value as string[]).join("|") + ")$", "i");
  };
  const sources = list("sources").map((s, i) => ({lang: lang("sources[" + i + "].languages", s.languages), re: new RegExp(regex("sources[" + i + "].pattern", s.pattern))}));
  const sinks = list("sinks").map((s, i): Sink => {
    const where = "sinks[" + i + "]";
    if (!SINK_KINDS.includes(s.kind as SinkKind)) fail(where + ".kind", "must be one of " + SINK_KINDS.join(", "));
    if (s.arg !== undefined && s.arg !== "all" && !(Number.isInteger(s.arg) && (s.arg as number) >= 0)) fail(where + ".arg", "must be an argument index (0 = first) or \"all\"");
    const call = regex(where + ".call", s.call);
    return {custom: true, kind: s.kind as SinkKind, call: new RegExp("(?:^|[^\\w$])(?:" + call + ")\\s*\\(", "g"), lang: lang(where + ".languages", s.languages),
      all: s.arg === "all", arg: typeof s.arg === "number" ? s.arg : undefined};
  });
  const sanitizers = list("sanitizers").map((s, i) => regex("sanitizers[" + i + "]", s.pattern ?? s.call));
  return {sinks, sources, sanitizer: sanitizers.length ? new RegExp("(?:^|[^\\w$])(?:" + sanitizers.join("|") + ")\\s*\\(") : undefined};
}

/** The workspace's .hushavyr/taint-rules.json, or undefined when there is none; throws on an invalid file. */
export async function loadTaintRules(root: string): Promise<TaintRules | undefined> {
  let text: string;
  try { text = await readFile(join(root, TAINT_RULES_FILE), "utf8"); } catch { return undefined; }
  return parseTaintRules(text);
}
