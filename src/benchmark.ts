import { LocalOllama } from "./model/ollama";
import { ReviewSource } from "./review/context";
import { Finding, reviewPrompt, validateReview } from "./review/review";
import { readFileSync } from "node:fs";
import { runLocalReview } from "./review/localReview";
import { staticReview } from "./staticReview";
import { join } from "node:path";
import { reviewDifficulty } from "./review/difficulty";

// alsoLines: other lines where the same bug is correctly reported (e.g. a declaration and its use).
export interface BenchmarkCase { id: string; sources: ReviewSource[]; expected?: {path: string; line: number; alsoLines?: number[]; mechanism: RegExp} }
// Synthetic, public examples. Scores measure this small fixture set only.
export const benchmarkCases: BenchmarkCase[] = [
  {id: "json-escaping-bug", sources: [{path: "Mapper.java", text: String.raw`class Mapper {
  String error(String tenantId) {
    return "{\"error\":\"" + tenantId + "\"}";
  }
}`}], expected: {path: "Mapper.java", line: 3, mechanism: /json|escap|serializ/i}},
  {id: "json-serializer-clean", sources: [{path: "Mapper.java", text: `import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.Map;
class Mapper {
  String error(String tenantId) throws JsonProcessingException {
    return new ObjectMapper().writeValueAsString(Map.of("error", tenantId == null ? "" : tenantId));
  }
}`}]},
  {id: "null-before-guard-bug", sources: [{path: "Names.java", text: `class Names {
  String normalize(String value) {
    String result = value.trim();
    return value == null ? "" : result;
  }
}`}], expected: {path: "Names.java", line: 3, mechanism: /null|dereferen/i}},
  {id: "null-guard-clean", sources: [{path: "Names.java", text: `class Names {
  String normalize(String value) {
    return value == null ? "" : value.trim();
  }
}`}]},
  {id: "integer-overflow-bug", sources: [{path: "Price.java", text: `class Price {
  long total(int quantity, int unitCents) {
    return quantity * unitCents;
  }
}`}], expected: {path: "Price.java", line: 3, mechanism: /overflow|integer|multipli|32.bit/i}},
  {id: "integer-promotion-clean", sources: [{path: "Price.java", text: `class Price {
  long total(int quantity, int unitCents) {
    return (long) quantity * unitCents;
  }
}`}]},
  {id: "cross-file-null-bug", sources: [{path: "Lookup.java", text: `class Lookup {
  String find(int id) { return null; }
}`}, {path: "Service.java", text: `class Service {
  String name(Lookup lookup, int id) {
    if (lookup == null) return "";
    return lookup.find(id).trim();
  }
}`}], expected: {path: "Service.java", line: 4, mechanism: /null|dereferen/i}},
  {id: "cross-file-guard-clean", sources: [{path: "Lookup.java", text: `class Lookup {
  String find(int id) { return null; }
}`}, {path: "Service.java", text: `class Service {
  String name(Lookup lookup, int id) {
    if (lookup == null) return "";
    String value = lookup.find(id);
    return value == null ? "" : value.trim();
  }
}`}]},
  {id: "python-mutable-default-bug", sources: [{path: "events.py", text: `def add_event(event, events=[]):
    events.append(event)
    return events`}], expected: {path: "events.py", line: 1, mechanism: /mutable|shared|default/i}},
  {id: "python-mutable-default-clean", sources: [{path: "events.py", text: `def add_event(event, events=None):
    if events is None:
        events = []
    events.append(event)
    return events`}]},
  {id: "typescript-zero-limit-bug", sources: [{path: "limits.ts", text: `// An explicit limit of zero must stay zero.
export function getLimit(limit?: number): number {
  return limit || 10;
}`}], expected: {path: "limits.ts", line: 3, mechanism: /zero|0|nullish|falsy/i}},
  {id: "typescript-zero-limit-clean", sources: [{path: "limits.ts", text: `// An explicit limit of zero must stay zero.
export function getLimit(limit?: number): number {
  return limit ?? 10;
}`}]},
  {id: "javascript-numeric-sort-bug", sources: [{path: "scores.js", text: `// Return a sorted copy in ascending numeric order.
export function sortedScores(scores) {
  return [...scores].sort();
}`}], expected: {path: "scores.js", line: 3, mechanism: /string|lexicograph|comparator|numeric/i}},
  {id: "java-sql-injection-bug", sources: [{path: "UserLookup.java", text: `import java.sql.*;
class UserLookup {
  ResultSet find(Statement stmt, String user) throws SQLException {
    return stmt.executeQuery("SELECT * FROM users WHERE name = '" + user + "'");
  }
}`}], expected: {path: "UserLookup.java", line: 4, mechanism: /sql|inject|parameter|query/i}},
  {id: "java-sql-parameterized-clean", sources: [{path: "UserLookup.java", text: `import java.sql.*;
class UserLookup {
  String find(Connection connection, String user) throws SQLException {
    try (PreparedStatement stmt = connection.prepareStatement("SELECT name FROM users WHERE name = ?")) {
      stmt.setString(1, user);
      try (ResultSet rs = stmt.executeQuery()) {
        return rs.next() ? rs.getString(1) : null;
      }
    }
  }
}`}]},
  {id: "javascript-tls-validation-disabled", sources: [{path: "client.js", text: `import https from "node:https";
export const agent = new https.Agent({rejectUnauthorized: false});`}], expected: {path: "client.js", line: 2, mechanism: /tls|certificat|validat|https/i}},
  {id: "javascript-tls-default-clean", sources: [{path: "client.js", text: `import https from "node:https";
export const agent = new https.Agent({rejectUnauthorized: true});`}]},
  {id: "python-shell-injection-bug", sources: [{path: "runner.py", text: `import subprocess
def run(command):
    return subprocess.run(command, shell=True, check=True)`}], expected: {path: "runner.py", line: 3, mechanism: /shell|inject|command|subprocess/i}},
  {id: "python-shell-argument-list-clean", sources: [{path: "runner.py", text: `import subprocess
def show(filename):
    """Print the file to the terminal."""
    subprocess.run(["cat", "--", filename], shell=False, check=True)`}]},
  {id: "javascript-numeric-sort-clean", sources: [{path: "scores.js", text: `/** Return a sorted copy in ascending numeric order. @param {number[]} scores */
export function sortedScores(scores) {
  return [...scores].sort((a, b) => a - b);
}`}]},
  {id: "javascript-sql-template-bug", sources: [{path: "users.js", text: "export async function findUser(db, name) {\n  const rows = await db.query(`SELECT * FROM users WHERE name = '${name}'`);\n  return rows[0];\n}"}], expected: {path: "users.js", line: 2, mechanism: /sql|inject|parameter|query/i}},
  {id: "javascript-sql-placeholder-clean", sources: [{path: "users.js", text: "export async function findUser(db, name) {\n  const rows = await db.query(\"SELECT * FROM users WHERE name = ?\", [name]);\n  return rows[0];\n}"}]},
  {id: "python-sql-fstring-bug", sources: [{path: "repo.py", text: `def find_user(cursor, name):
    cursor.execute(f"SELECT * FROM users WHERE name = '{name}'")
    return cursor.fetchone()`}], expected: {path: "repo.py", line: 2, mechanism: /sql|inject|parameter|query/i}},
  {id: "python-sql-parameter-clean", sources: [{path: "repo.py", text: `def find_user(cursor, name):
    cursor.execute("SELECT * FROM users WHERE name = %s", (name,))
    return cursor.fetchone()`}]},
  {id: "javascript-command-injection-bug", sources: [{path: "ping.js", text: `const {exec} = require("child_process");
module.exports = function ping(host, done) {
  exec("ping -c 1 " + host, done);
};`}], expected: {path: "ping.js", line: 3, mechanism: /command|inject|shell|exec/i}},
  {id: "javascript-execfile-clean", sources: [{path: "ping.js", text: `const {execFile} = require("child_process");
module.exports = function ping(host, done) {
  if (typeof host !== "string" || !/^[a-z0-9][a-z0-9.-]*$/i.test(host)) return done(new Error("invalid host"));
  execFile("ping", ["-c", "1", host], done);
};`}]},
  {id: "javascript-dom-xss-bug", sources: [{path: "greet.js", text: `export function greet(element, name) {
  element.innerHTML = "<h1>Hello " + name + "</h1>";
}`}], expected: {path: "greet.js", line: 2, mechanism: /xss|script|html|inject|escap/i}},
  {id: "javascript-textcontent-clean", sources: [{path: "greet.js", text: `export function greet(element, name) {
  element.textContent = "Hello " + name;
}`}]},
  {id: "python-yaml-load-bug", sources: [{path: "config.py", text: `import yaml
def load_config(text):
    return yaml.load(text)`}], expected: {path: "config.py", line: 3, mechanism: /yaml|deserial|safe_load|loader|code/i}},
  {id: "python-yaml-safe-clean", sources: [{path: "config.py", text: `import yaml
def load_config(text):
    return yaml.safe_load(text)`}]},
  {id: "java-weak-hash-bug", sources: [{path: "Passwords.java", text: `import java.security.MessageDigest;
class Passwords {
  byte[] hash(String password) throws Exception {
    return MessageDigest.getInstance("MD5").digest(password.getBytes("UTF-8"));
  }
}`}], expected: {path: "Passwords.java", line: 4, mechanism: /md5|weak|hash|crypt/i}},
  {id: "java-strong-hash-clean", sources: [{path: "Checksums.java", text: `import java.security.MessageDigest;
class Checksums {
  byte[] sha256(byte[] data) throws Exception {
    return MessageDigest.getInstance("SHA-256").digest(data);
  }
}`}]},
  {id: "java-off-by-one-bug", sources: [{path: "Totals.java", text: `class Totals {
  long sum(int[] values) {
    if (values == null) return 0;
    long total = 0;
    for (int i = 0; i <= values.length; i++) total += values[i];
    return total;
  }
}`}], expected: {path: "Totals.java", line: 5, mechanism: /bound|index|off.by.one|<=|ArrayIndexOutOfBounds|length/i}},
  {id: "java-loop-bounds-clean", sources: [{path: "Totals.java", text: `class Totals {
  long sum(int[] values) {
    if (values == null) return 0;
    long total = 0;
    for (int i = 0; i < values.length; i++) total += values[i];
    return total;
  }
}`}]},
  {id: "cross-file-sql-taint-bug", sources: [{path: "UserController.java", text: `class UserController {
  private final UserRepository repository;
  UserController(UserRepository repository) { this.repository = repository; }
  String show(javax.servlet.http.HttpServletRequest request) throws Exception {
    return repository.findName(request.getParameter("name"));
  }
}`}, {path: "UserRepository.java", text: `import java.sql.*;
class UserRepository {
  private final Connection connection;
  UserRepository(Connection connection) { this.connection = connection; }
  String findName(String name) throws SQLException {
    try (Statement stmt = connection.createStatement();
         ResultSet rs = stmt.executeQuery("SELECT name FROM users WHERE name = '" + name + "'")) {
      return rs.next() ? rs.getString(1) : null;
    }
  }
}`}], expected: {path: "UserRepository.java", line: 7, mechanism: /sql|inject|parameter|query/i}},
  {id: "go-sql-concat-bug", sources: [{path: "users.go", text: `package users

import "database/sql"

func FindName(db *sql.DB, id string) (string, error) {
    var name string
    err := db.QueryRow("SELECT name FROM users WHERE id = '" + id + "'").Scan(&name)
    return name, err
}`}], expected: {path: "users.go", line: 7, mechanism: /sql|inject|parameter|query|placeholder/i}},
  {id: "go-sql-placeholder-clean", sources: [{path: "users.go", text: `package users

import "database/sql"

func FindName(db *sql.DB, id string) (string, error) {
    var name string
    err := db.QueryRow("SELECT name FROM users WHERE id = $1", id).Scan(&name)
    return name, err
}`}]},
  {id: "go-nil-map-bug", sources: [{path: "counts.go", text: `package text

func CountWords(words []string) map[string]int {
    var counts map[string]int
    for _, w := range words {
        counts[w]++
    }
    return counts
}`}], expected: {path: "counts.go", line: 6, alsoLines: [4], mechanism: /nil|make|initiali|panic/i}},
  {id: "go-nil-map-clean", sources: [{path: "counts.go", text: `package text

func CountWords(words []string) map[string]int {
    counts := make(map[string]int)
    for _, w := range words {
        counts[w]++
    }
    return counts
}`}]},
  {id: "go-index-bug", sources: [{path: "last.go", text: `package items

// Last returns the last element, or "" for an empty slice.
func Last(items []string) string {
    if len(items) == 0 {
        return ""
    }
    return items[len(items)]
}`}], expected: {path: "last.go", line: 8, mechanism: /index|range|bound|len|off.by.one|panic/i}},
  {id: "go-index-clean", sources: [{path: "last.go", text: `package items

// Last returns the last element, or "" for an empty slice.
func Last(items []string) string {
    if len(items) == 0 {
        return ""
    }
    return items[len(items)-1]
}`}]},
  {id: "csharp-sql-concat-bug", sources: [{path: "Users.cs", text: `using Microsoft.Data.SqlClient;

class Users {
  public string Find(SqlConnection conn, string name) {
    using var cmd = new SqlCommand("SELECT Name FROM Users WHERE Name = '" + name + "'", conn);
    return cmd.ExecuteScalar() as string;
  }
}`}], expected: {path: "Users.cs", line: 5, mechanism: /sql|inject|parameter|query/i}},
  {id: "csharp-sql-parameter-clean", sources: [{path: "Users.cs", text: `using Microsoft.Data.SqlClient;

class Users {
  public string Find(SqlConnection conn, string name) {
    using var cmd = new SqlCommand("SELECT Name FROM Users WHERE Name = @name", conn);
    cmd.Parameters.AddWithValue("@name", name);
    return cmd.ExecuteScalar() as string;
  }
}`}]},
  {id: "csharp-firstordefault-null-bug", sources: [{path: "Accounts.cs", text: `using System.Collections.Generic;
using System.Linq;

record User(int Id, string Name);

class Accounts {
  public string NameOf(List<User> users, int id) {
    return users.FirstOrDefault(u => u.Id == id).Name;
  }
}`}], expected: {path: "Accounts.cs", line: 8, mechanism: /null|FirstOrDefault|not found|missing/i}},
  {id: "csharp-firstordefault-null-clean", sources: [{path: "Accounts.cs", text: `using System.Collections.Generic;
using System.Linq;

record User(int Id, string Name);

class Accounts {
  public string NameOf(List<User> users, int id) {
    return users.FirstOrDefault(u => u.Id == id)?.Name ?? "";
  }
}`}]},
  {id: "csharp-insecure-random-bug", sources: [{path: "Tokens.cs", text: `using System;

class Tokens {
  // Creates a password-reset token.
  public string ResetToken() {
    var bytes = new byte[32];
    new Random().NextBytes(bytes);
    return Convert.ToHexString(bytes);
  }
}`}], expected: {path: "Tokens.cs", line: 7, mechanism: /random|predict|crypto|secure/i}},
  {id: "csharp-secure-random-clean", sources: [{path: "Tokens.cs", text: `using System;
using System.Security.Cryptography;

class Tokens {
  // Creates a password-reset token.
  public string ResetToken() {
    var bytes = new byte[32];
    RandomNumberGenerator.Fill(bytes);
    return Convert.ToHexString(bytes);
  }
}`}]},
  {id: "typescript-missing-await-bug", sources: [{path: "save.ts", text: `export async function saveAll(store: {write(item: string): Promise<void>}, items: string[]): Promise<number> {
  for (const item of items) {
    store.write(item);
  }
  return items.length;
}`}], expected: {path: "save.ts", line: 3, mechanism: /await|promise|async|floating/i}},
  {id: "typescript-await-clean", sources: [{path: "save.ts", text: `export async function saveAll(store: {write(item: string): Promise<void>}, items: string[]): Promise<number> {
  for (const item of items) {
    await store.write(item);
  }
  return items.length;
}`}]},
  {id: "typescript-indexof-bug", sources: [{path: "tags.ts", text: `export function hasTag(tags: string[], tag: string): boolean {
  return tags.indexOf(tag) > 0;
}`}], expected: {path: "tags.ts", line: 2, mechanism: /index|first|zero|0|off.by.one/i}},
  {id: "typescript-includes-clean", sources: [{path: "tags.ts", text: `export function hasTag(tags: string[], tag: string): boolean {
  return tags.includes(tag);
}`}]}

];

const LANGUAGES: Record<string, string> = {java: "java", py: "python", js: "javascript", ts: "typescript", go: "go", cs: "csharp"};
export function language(fixture: BenchmarkCase): string {
  const ext = fixture.sources[0].path.split(".").pop() ?? "";
  return LANGUAGES[ext] ?? ext;
}

export function scoreCase(fixture: BenchmarkCase, findings: readonly Finding[]) {
  const expected = fixture.expected;
  const matched = expected ? findings.findIndex(f => f.path === expected.path && f.line !== undefined &&
    [expected.line, ...expected.alsoLines ?? []].some(line => f.line! <= line && f.line! + f.evidence.split('\n').length > line) &&
    expected.mechanism.test(f.title + " " + f.fix)) : -1;
  return {truePositive: matched >= 0 ? 1 : 0, falseNegative: expected && matched < 0 ? 1 : 0,
    falsePositive: findings.length - (matched >= 0 ? 1 : 0), cleanPass: !expected && !findings.length};
}
// The same instruction as the terminal /review, so the benchmark measures what ships.
const instruction = "Review this code file. Find concrete potential bugs with severity, evidence, fixes, and regression tests.";

export function scoreReviewResponses(responses: Record<string, unknown>) {
  const ids = benchmarkCases.map(fixture => fixture.id);
  if (Object.keys(responses).length !== ids.length || ids.some(id => typeof responses[id] !== "string")) {
    throw new Error("Provide one response string for every benchmark case ID.");
  }
  const cases = benchmarkCases.map(fixture => {
    const review = validateReview(responses[fixture.id] as string, fixture.sources);
    const score = scoreCase(fixture, review.findings);
    return {id: fixture.id, ...score, cleanPass: score.cleanPass && !review.error && review.rejected === 0,
      rejectedFindings: review.rejected, invalidResponse: Boolean(review.error)};
  });
  const totals = cases.reduce((sum, row) => ({
    truePositive: sum.truePositive + row.truePositive,
    falsePositive: sum.falsePositive + row.falsePositive,
    falseNegative: sum.falseNegative + row.falseNegative,
    rejectedFindings: sum.rejectedFindings + row.rejectedFindings,
    invalidResponses: sum.invalidResponses + Number(row.invalidResponse)
  }), {truePositive: 0, falsePositive: 0, falseNegative: 0, rejectedFindings: 0, invalidResponses: 0});
  const {truePositive: tp, falsePositive: fp, falseNegative: fn} = totals;
  return {cases, totals, precision: tp + fp ? tp / (tp + fp) : null, recall: tp + fn ? tp / (tp + fn) : null};
}

/** Offline comparison of responses supplied by the user; never calls provider APIs. */
export function compareReviewResponses(providers: Record<string, Record<string, unknown>>) {
  const names = Object.keys(providers);
  if (!names.length || names.length > 10) throw new Error("Provide 1-10 named provider response sets.");
  return {
    fixtureCount: benchmarkCases.length,
    providers: names.map(name => {
      if (!name.trim() || !providers[name] || typeof providers[name] !== "object" || Array.isArray(providers[name]))
        throw new Error("Each provider must have a named object of benchmark responses.");
      return {name, ...scoreReviewResponses(providers[name])};
    }),
    limitation: "Offline scoring of supplied JSON only. Labels are user-provided and do not verify model identity, provider access, token costs or latency. No cloud requests."
  };
}

const rules = join(__dirname, "..", "rules", "hushavyr-review.yml");
// Bugs that a pattern rule can reasonably catch; correctness bugs are the model's job.
const STATIC_SCOPE = /sql|command|shell|tls|xss|yaml|hash/;

/** Deterministic half of the hybrid review, scored on the same fixtures. No model involved. */
export async function staticBenchmark() {
  let status = "ok";
  const cases = [];
  for (const fixture of benchmarkCases) {
    const result = await staticReview(fixture.sources, rules);
    if (result.status !== "ok") status = result.status;
    cases.push({id: fixture.id, inScope: STATIC_SCOPE.test(fixture.id), ...scoreCase(fixture, result.findings)});
  }
  const scoped = cases.filter(c => c.inScope && benchmarkCases.find(f => f.id === c.id)?.expected);
  const tp = cases.reduce((n, c) => n + c.truePositive, 0), fp = cases.reduce((n, c) => n + c.falsePositive, 0);
  const found = scoped.filter(c => c.truePositive).length;
  return {semgrep: status, fixtureCount: cases.length, truePositives: tp, falsePositives: fp,
    securityRecall: scoped.length ? found / scoped.length : null, missed: scoped.filter(c => !c.truePositive).map(c => c.id),
    falsePositiveCases: cases.filter(c => c.falsePositive).map(c => c.id), cases};
}

/** CI gate: semgrep must run, no clean fixture may be flagged, and every in-scope security bug must be found. */
export function staticGateProblems(report: Awaited<ReturnType<typeof staticBenchmark>>): string[] {
  const problems: string[] = [];
  if (report.semgrep !== "ok") problems.push("semgrep " + report.semgrep);
  if (report.falsePositives) problems.push("false positives in " + report.falsePositiveCases.join(", "));
  if (report.securityRecall !== 1) problems.push("missed " + report.missed.join(", "));
  return problems;
}

async function main(args: string[]) {
  if (args.length === 1 && args[0] === "--prompts") {
    console.log(JSON.stringify(Object.fromEntries(benchmarkCases.map(fixture =>
      [fixture.id, reviewPrompt(instruction, fixture.sources)])), null, 2));
    return;
  }
  if (args.length === 2 && args[0] === "--score") {
    const responses: unknown = JSON.parse(readFileSync(args[1], "utf8"));
    if (!responses || typeof responses !== "object" || Array.isArray(responses)) {
      throw new Error("Expected a JSON object mapping case IDs to response strings.");
    }
    console.log(JSON.stringify(scoreReviewResponses(responses as Record<string, unknown>), null, 2));
    return;
  }
  if (args.length === 2 && args[0] === "--compare") {
    const payload: unknown = JSON.parse(readFileSync(args[1], "utf8"));
    if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
        !("providers" in payload) || !payload.providers || typeof payload.providers !== "object" ||
        Array.isArray(payload.providers)) throw new Error("Expected {providers:{name:{fixtureId:responseString}}}.");
    console.log(JSON.stringify(compareReviewResponses(payload.providers as Record<string, Record<string, unknown>>), null, 2));
    return;
  }
  if (args[0] === "--static") {
    const report = await staticBenchmark();
    console.log(JSON.stringify(report, null, 2));
    if (args.includes("--gate")) {
      const problems = staticGateProblems(report);
      if (problems.length) { console.error("Static gate failed: " + problems.join("; ")); process.exitCode = 1; }
      else console.error("Static gate passed.");
    }
    return;
  }
  if (args.length) throw new Error("Usage: review:benchmark [--prompts | --score responses.json | --compare providers.json | --static [--gate]]");

  const model = process.env.OLLAMA_MODEL ?? "qwen2.5-coder:7b";
  const verifierModel = process.env.OLLAMA_VERIFIER_MODEL ?? model;
  const endpoint = process.env.OLLAMA_ENDPOINT;
  const client = new LocalOllama({model, endpoint, timeoutMs: 180000});
  const verifier = new LocalOllama({model: verifierModel, endpoint, timeoutMs: 180000});
  await client.ensureAvailable();
  if (verifierModel !== model) await verifier.ensureAvailable();
  const depth = process.env.REVIEW_DEPTH === "fast" ? "fast" : "thorough";
  const useStatic = process.env.REVIEW_STATIC !== "0";
  let tp = 0, fp = 0, fn = 0, errors = 0, verifierFailures = 0;
  const cases: object[] = [];
  const byLanguage: Record<string, {truePositives: number; falsePositives: number; falseNegatives: number; cases: number}> = {};
  // How well "the local model is unsure" predicts its own mistakes (the escalation suggestion).
  const unsure = {mistakes: 0, onMistakes: 0, correct: 0, onCorrect: 0};
  for (const fixture of benchmarkCases) {
    const started = Date.now();
    try {
      const staticFindings = useStatic ? staticReview(fixture.sources, rules).then(r => r.findings) : undefined;
      const result = await runLocalReview(client, instruction, fixture.sources, () => false, verifier, {depth, staticFindings});
      if (!result || result.error) throw new Error("Review failed");
      const score = scoreCase(fixture, result.findings);
      tp += score.truePositive; fp += score.falsePositive; fn += score.falseNegative;
      if (result.verifierFailed) verifierFailures++;
      const difficulty = reviewDifficulty(result, fixture.sources.map(s => s.text).join("\n"));
      const wrong = score.falsePositive > 0 || score.falseNegative > 0;
      unsure[wrong ? "onMistakes" : "onCorrect"] += difficulty.hard ? 1 : 0;
      unsure[wrong ? "mistakes" : "correct"]++;
      const lang = language(fixture);
      byLanguage[lang] ??= {truePositives: 0, falsePositives: 0, falseNegatives: 0, cases: 0};
      byLanguage[lang].truePositives += score.truePositive; byLanguage[lang].falsePositives += score.falsePositive;
      byLanguage[lang].falseNegatives += score.falseNegative; byLanguage[lang].cases++;
      cases.push({id: fixture.id, ...score, verifierFailed: !!result.verifierFailed, findings: result.findings.map(f => f.line + " " + f.title), unsure: difficulty.reasons, durationMs: Date.now() - started});
    } catch {
      errors++; if (fixture.expected) fn++;
      unsure.mistakes++; unsure.onMistakes++;
      cases.push({id: fixture.id, error: true, durationMs: Date.now() - started});
    }
  }
  console.log(JSON.stringify({model, verifierModel, depth, staticAnalysis: useStatic, fixtureCount: benchmarkCases.length, cases,
    truePositives: tp, falsePositives: fp, falseNegatives: fn, errors, verifierFailures, byLanguage,
    precision: tp + fp ? tp / (tp + fp) : null, recall: tp + fn ? tp / (tp + fn) : null,
    escalationSuggested: {onMistakes: unsure.onMistakes + "/" + unsure.mistakes, onCorrect: unsure.onCorrect + "/" + unsure.correct},
    limitation: "Synthetic fixture benchmark only. No Sonnet or Sol comparison was executed. Finding titles are included; no raw source."}, null, 2));
  if (errors || verifierFailures || fp || fn) process.exitCode = 1;
}
if (require.main === module) main(process.argv.slice(2)).catch((error: Error) => {
  console.error("Benchmark stopped:", error.message);
  process.exitCode = 1;
});
