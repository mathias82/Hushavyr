import {test} from "node:test";
import assert from "node:assert/strict";
import {authorMismatch, parseRemote, type Run} from "../../git/identity";

test("parseRemote reads host, owner/repo and the URL user of https and ssh remotes; local paths are not GitHub", () => {
  assert.deepEqual(parseRemote("https://mathias82@github.com/mathias82/Hushavyr.git"), {host: "github.com", repo: "mathias82/Hushavyr", user: "mathias82"});
  assert.deepEqual(parseRemote("https://github.com/org/repo"), {host: "github.com", repo: "org/repo", user: undefined});
  assert.deepEqual(parseRemote("git@github.com:org/repo.git"), {host: "github.com", repo: "org/repo", user: undefined});
  assert.equal(parseRemote("/tmp/origin.git"), undefined);
});

function fake(answers: Record<string, string>, calls: {args: string[]; env?: Record<string, string>}[] = []): Run {
  return async (cmd, args, _cwd, env) => {
    calls.push({args: [cmd, ...args], env});
    const key = Object.keys(answers).find(k => [cmd, ...args].join(" ").startsWith(k));
    if (key === undefined) throw new Error("not set");
    return answers[key];
  };
}
const base = {
  "git config user.email": "me@hotmail.com\n",
  "git remote get-url origin": "https://github.com/org/repo.git\n",
  "gh api --hostname github.com repos/org/repo": "true\n",
  "gh api --hostname github.com user": "me-work\tme@work.com\t42\n",
};

test("authorMismatch: flags a commit email GitHub would not credit, and stays quiet when unsure", async () => {
  assert.deepEqual(await authorMismatch("/r", fake(base)), {current: "me@hotmail.com", expected: "me@work.com", login: "me-work"});
  for (const email of ["ME@work.com", "me-work@users.noreply.github.com", "42+me-work@users.noreply.github.com"]) {
    assert.equal(await authorMismatch("/r", fake({...base, "git config user.email": email})), undefined, email);
  }
  assert.equal(await authorMismatch("/r", fake({...base, "git config --local hushavyr.keepEmail": "me@hotmail.com"})), undefined, "kept by the user");
  assert.equal(await authorMismatch("/r", fake({...base, "gh api --hostname github.com repos/org/repo": "false"})), undefined, "no push access: another account");
  assert.equal(await authorMismatch("/r", fake({...base, "gh api --hostname github.com user": "me-work\t\t42"})), undefined, "no public email");
  const {"gh api --hostname github.com user": _u, ...noGh} = base;
  assert.equal(await authorMismatch("/r", fake(noGh)), undefined, "gh missing or offline");
});

test("authorMismatch asks GitHub as the account in the remote URL, not the active gh account", async () => {
  const calls: {args: string[]; env?: Record<string, string>}[] = [];
  await authorMismatch("/r", fake({...base, "git remote get-url origin": "https://mathias82@github.com/org/repo.git", "gh auth token -h github.com -u mathias82": "tok\n"}, calls));
  assert.ok(calls.filter(c => c.args[1] === "api").every(c => c.env?.GH_TOKEN === "tok"));
});
