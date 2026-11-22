# Real-world benchmarks: Juice Shop, WebGoat, DVWA, RailsGoat, GoVWA, WebGoat.NET

The OWASP Benchmark is synthetic. To see how the Hushavyr scanner does on real code, we run the CLI (built-in rules and data-flow tracking only, no AI model, nothing leaves the machine) on six open-source applications that are vulnerable on purpose, one or more per language:

| App | Language | Commit |
| --- | --- | --- |
| [OWASP Juice Shop](https://github.com/juice-shop/juice-shop) | TypeScript / Angular | `c9f9922` |
| [OWASP WebGoat](https://github.com/WebGoat/WebGoat) | Java / Spring | `4e98f1c` |
| [DVWA](https://github.com/digininja/DVWA) | PHP | `502ac15` |
| [RailsGoat](https://github.com/OWASP/railsgoat) | Ruby on Rails | `f5951f1` |
| [GoVWA](https://github.com/0c34/govwa) | Go | `4058f79` |
| [WebGoat.NET](https://github.com/jerryhoff/WebGoat.NET) | C# / ASP.NET | `1c6cab1` |

Command: `node dist/cli.js <app> --sarif <app>.sarif --fail-on none`. Each app scans in seconds on a laptop.

## Before and after 1.0.5

"Code findings" excludes dependency CVEs. "Data flows" are proven paths from request input to a dangerous call (`taint-*` rules).

| App | Code findings (1.0.4 → 1.0.5) | Data flows (1.0.4 → 1.0.5) | Data flows by kind in 1.0.5 |
| --- | ---: | ---: | --- |
| Juice Shop | 166 → 187 | 4 → 9 | NoSQL 2, path 5, SSRF 1, code 1 |
| WebGoat | 81 → 80 | 23 → 22 | SQL 15, path 6, command 1 |
| DVWA | 21 → 97 | 0 → 51 | SQL 26, path 11, command 8, redirect 3, code 2, XSS 1 |
| RailsGoat | 13 → 30 | 0 → 8 | code 3, SQL 1, path 1, deserialization 1, redirect 1, XSS 1 |
| GoVWA | 4 → 9 | 0 → 2 | SQL 1, XSS 1 |
| WebGoat.NET | 3 → 37 | 0 → 29 | SQL 17, XSS 7, path 3, XPath 1, redirect 1 |

The OWASP Benchmark scores did not change: Java 97.2%, Python 100%, both with 0% false positives.

## What 1.0.5 added

- **PHP:** `$_GET`, `$_POST`, `$_REQUEST`, `$_COOKIE` and `$_FILES` as sources; `"…$id…"` and `{$x}` interpolation; `.=`; sinks such as `mysqli_query`, `shell_exec`, `include`, `unserialize`, `header("Location: …")`, `curl_init`, `echo`; `intval`, `is_numeric`, `htmlspecialchars` and `escapeshellarg` as sanitizers.
- **Go:** `r.FormValue`, `URL.Query()`, `mux.Vars`, gin `c.Query` as sources; `:=` and `a, b :=`; `db.Query/Exec`, `exec.Command("sh", "-c", …)`, `http.Get`, `http.Redirect`, `template.HTML`, `fmt.Fprintf(w, …)`; prepared statements (`stmt, _ := db.Prepare(…)`) are recognized as safe.
- **C#:** `Request.QueryString`, `Request.Form`, `[FromQuery]` and WebForms text boxes as sources; `$"…{x}…"`; `new SqlCommand/…DataAdapter`, `CommandText =`, EF raw SQL, `Process.Start`, `File.*`, `Response.Write`, `Response.Redirect`, `DirectorySearcher`, `SelectNodes`, `BinaryFormatter.Deserialize`.
- **Ruby/Rails:** `params[…]`, `cookies[…]` as sources; `"#{x}"`; `where("…#{x}")` (hash conditions are safe), `constantize`, `send`, `system`, backticks, `Marshal.load`, `YAML.load`, `send_file`, `redirect_to`, `html_safe`, `raw`.
- **JavaScript/TypeScript:** MongoDB `$where` NoSQL injection, `vm.runInContext`, `res.redirect`, Zip Slip (`entry.path` from unzipper/adm-zip), quotes inside template literals (`` `id = '${id}'` ``), and ternaries whose arms carry the input.
- **Rules:** XXE (`noent: true`, `XML_PARSE_NOENT`, `LIBXML_NOENT`, `DtdProcessing.Parse`), Angular `bypassSecurityTrust*`, `node:vm` used as a sandbox, Go `fmt.Sprintf` SQL, C# SQL concatenation, `BinaryFormatter` / `TypeNameHandling`, weak hashes, ciphers and random numbers in Go, C#, PHP and Ruby, PHP `extract($_GET)`, `[ValidateInput(false)]`, Rails `skip_before_action :verify_authenticity_token` and `permit!`.
- **Fewer false positives:** a ternary condition no longer taints the whole value (removed a WebGoat command-injection false positive), and Go prepared statements no longer count as SQL sinks (removed two GoVWA false positives).

## Found per app

- **Juice Shop:** NoSQL `$where` in `trackOrder.ts` and `showProductReviews.ts`, Zip Slip in `fileUpload.ts`, XXE in `lib/xml.ts`, 12 `bypassSecurityTrust*` XSS sinks, 3 `vm` sandboxes, SQL injection in login and search, `eval` in `userProfile.ts`, SSRF in `profileImageUrlUpload.ts`. HIGH: 38 findings, 37 real (one Klingon translation reported as a credential).
- **WebGoat:** SQL injection lessons, path traversal, command injection, XStream and other dependency CVEs.
- **DVWA:** SQL injection and blind SQL injection, command injection, file inclusion, open redirect, `eval` in the help viewer, MD5 password hashing, and the CSRF, captcha and brute-force levels.
- **RailsGoat:** SQL injection in `users_controller`, `constantize` remote code execution, `send_file` path traversal, `Marshal.load` in password resets, open redirect in `sessions_controller`, `html_safe` in a flash message, mass assignment and MD5 passwords.
- **GoVWA:** SQL injection in `UnsafeQueryGetData`, reflected XSS, weak hashes.
- **WebGoat.NET:** SQL injection in every MySQL and SQLite provider method reached from a page, reflected XSS, path traversal, XPath injection, open redirect, `BinaryFormatter`.

## Known false positives

- DVWA `upload/impossible.php`: `rename`/`unlink` on a temporary upload file.
- Juice Shop: the Klingon translation `"mu'wIj"` reported as a credential.

## Known misses

- Juice Shop: the open-redirect allow-list bypass in `routes/redirect.ts` (`isRedirectAllowed` uses `includes`); the redirect is guarded, so it is not reported.
- DVWA reflected and stored XSS: the HTML is built in one file and echoed in another.
- RailsGoat: `system` inside a model method (`benefits.rb`) and SQL built in a scope lambda.
- Business-logic flaws (IDOR, broken access control, weak session IDs) need the local AI review (`/review`, `/scan`) or a manual check.

No tool is perfect; findings are potential issues and need checking before acting.
