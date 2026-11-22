import assert from "node:assert/strict";
import {test} from "node:test";
import {taintFlows} from "../taint";

const kinds = (path: string, text: string) => taintFlows([{path, text}]).map(f => `${f.kind}:${f.sink.line}`);

test("PHP superglobals reach SQL, command and include sinks, including through interpolation", () => {
  const php = [
    "<?php",
    "$id = $_GET['id'];",
    "$q = \"SELECT * FROM users WHERE id = '$id'\";",
    "mysqli_query($conn, $q);",
    "shell_exec('ping ' . $_POST['ip']);",
    "include $_GET['page'];",
    "$safe = intval($_GET['n']);",
    "mysqli_query($conn, \"SELECT * FROM t WHERE n = $safe\");",
  ].join("\n");
  assert.deepEqual(kinds("a.php", php).sort(), ["command:5", "path:6", "sql:4"]);
});

test("Go request values reach SQL through := and Sprintf, but prepared statements are safe", () => {
  const go = [
    "func handler(w http.ResponseWriter, r *http.Request) {",
    "\tid := r.FormValue(\"id\")",
    "\tq := fmt.Sprintf(\"SELECT * FROM t WHERE id = %s\", id)",
    "\trows, err := db.Query(q)",
    "\tstmt, err := db.Prepare(\"SELECT * FROM t WHERE id = ?\")",
    "\tstmt.QueryRow(id)",
    "\thttp.Redirect(w, r, id, 302)",
    "}",
  ].join("\n");
  assert.deepEqual(kinds("h.go", go).sort(), ["redirect:7", "sql:4"]);
});

test("C# request input reaches ADO.NET commands and interpolated strings; int.Parse sanitizes", () => {
  const cs = [
    "public class C : Controller {",
    "  public void Get() {",
    "    string name = Request.QueryString[\"name\"];",
    "    var cmd = new SqlCommand($\"SELECT * FROM t WHERE n = '{name}'\", conn);",
    "    int n = int.Parse(Request.Form[\"n\"]);",
    "    var safe = new SqlCommand(\"SELECT * FROM t WHERE n = \" + n, conn);",
    "    Response.Redirect(name);",
    "  }",
    "}",
  ].join("\n");
  assert.deepEqual(kinds("C.cs", cs).sort(), ["redirect:7", "sql:4"]);
});

test("Ruby params reach SQL, constantize and send_file; hash conditions are safe", () => {
  const rb = [
    "class UsersController < ApplicationController",
    "  def show",
    "    @user = User.where(\"id = '#{params[:id]}'\")",
    "    User.where(id: params[:id])",
    "    klass = params[:type].constantize",
    "    send_file params[:file]",
    "  end",
    "end",
  ].join("\n");
  assert.deepEqual(kinds("users_controller.rb", rb).sort(), ["code:5", "path:6", "sql:3"]);
});

test("JS $where NoSQL injection is found through ternary arms and quoted template interpolation", () => {
  const js = [
    "export function track () {",
    "  return (req, res) => {",
    "    const id = flag ? String(req.params.id).replace(/x/g, '') : utils.trunc(req.params.id, 60)",
    "    db.orders.find({ $where: `this.orderId === '${id}'` })",
    "    db.orders.find({ orderId: id })",
    "  }",
    "}",
  ].join("\n");
  assert.deepEqual(kinds("track.ts", js), ["nosql:4"]);
});

test("If guards: validated variables are safe inside the guard or after an exiting negated check", () => {
  const php = [
    "<?php",
    "$id = $_GET['id'];",
    "if (is_numeric($id)) { mysqli_query($c, \"SELECT * FROM t WHERE id = $id\"); }",
    "mysqli_query($c, \"SELECT * FROM t WHERE id = $id\");",
    "$p = $_GET['p'];",
    "if (!preg_match('/^[a-z]+$/', $p)) { exit; }",
    "include $p . '.php';",
    "$q = $_GET['q'];",
    "if (!preg_match('/^.*$/', $q)) exit;",
    "include $q;",
    "$e = $_GET['e'];",
    "if ($x) { $e = mysqli_real_escape_string($c, $e); mysqli_query($c, \"SELECT * FROM t WHERE id = $e\"); }",
  ].join("\n");
  assert.deepEqual(kinds("a.php", php).sort(), ["path:10", "sql:12", "sql:4"]);
  const ts = [
    "export function h () {",
    "  return (req, res) => {",
    "    const id = req.query.id",
    "    if (!/^\\d+$/.test(id)) { return res.status(400).end() }",
    "    db.query('SELECT * FROM t WHERE id = ' + id)",
    "    const to = req.query.to",
    "    if (allowed.includes(to)) {",
    "      res.redirect(to)",
    "    } else {",
    "      res.redirect(to)",
    "    }",
    "  }",
    "}",
  ].join("\n");
  assert.deepEqual(kinds("h.ts", ts), ["redirect:10"]);
});

test("A clean value assigned inside a conditional block is safe only until the block closes", () => {
  const php = [
    "<?php",
    "$t = $_GET['t'];",
    "$o = explode('.', $t);",
    "if (is_numeric($o[0]) && is_numeric($o[1])) {",
    "  $t = $o[0] . '.' . $o[1];",
    "  shell_exec('ping ' . $t);",
    "}",
    "shell_exec('ping ' . $t);",
  ].join("\n");
  assert.deepEqual(kinds("p.php", php), ["command:8"]);
});
