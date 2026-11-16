import {test} from "node:test";
import {strict as assert} from "node:assert";
import {execFileSync} from "node:child_process";
import {mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

const {updateLocal} = require("../../scripts/update-local.cjs") as {
  updateLocal(cwd: string, log?: (text: string) => void): {
    head: string; backups: {path: string; backup: string}[]; backupDirectory?: string;
  };
};
function fixture(run: (local: string, advance: (files: Record<string, string>) => string, git: (cwd: string, args: string[]) => string) => void) {
  const directory = mkdtempSync(join(tmpdir(), "privacy-update-test-"));
  const git = (cwd: string, args: string[]) => execFileSync("git", args, {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: {...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null"}
  }).trim();
  try {
    const remote = join(directory, "remote.git"), source = join(directory, "source"), local = join(directory, "local");
    git(directory, ["init", "--bare", "--initial-branch=main", remote]);
    git(directory, ["clone", remote, source]);
    for (const [key, value] of [["user.name", "Fixture"], ["user.email", "fixture@example.test"], ["commit.gpgsign", "false"]]) {
      git(source, ["config", key, value]);
    }
    writeFileSync(join(source, "README.md"), "initial\n");
    writeFileSync(join(source, ".gitignore"), "ignored.local\n");
    git(source, ["add", "."]); git(source, ["commit", "-m", "Initial"]); git(source, ["push", "origin", "main"]);
    git(directory, ["clone", remote, local]);
    for (const [key, value] of [["user.name", "Fixture"], ["user.email", "fixture@example.test"], ["commit.gpgsign", "false"]]) {
      git(local, ["config", key, value]);
    }
    const advance = (files: Record<string, string>): string => {
      for (const [path, content] of Object.entries(files)) writeFileSync(join(source, path), content);
      git(source, ["add", "-f", "--", ...Object.keys(files)]);
      git(source, ["commit", "-m", "Incoming files"]); git(source, ["push", "origin", "main"]);
      return git(source, ["rev-parse", "HEAD"]);
    };
    run(local, advance, git);
  } finally {rmSync(directory, {recursive: true, force: true});}
}

test("local update preserves all colliding untracked files and adopts tracked remote lockfile", () => {
  fixture((local, advance, git) => {
    const incoming = advance({"package-lock.json": '{"remote":true}', "settings.json": "remote settings"});
    writeFileSync(join(local, "package-lock.json"), '{"local":true}');
    writeFileSync(join(local, "settings.json"), "local settings");
    writeFileSync(join(local, "notes.txt"), "unrelated");
    const result = updateLocal(local, () => {});
    assert.equal(result.head, incoming);
    assert.equal(git(local, ["rev-parse", "HEAD"]), incoming);
    assert.equal(readFileSync(join(local, "package-lock.json"), "utf8"), '{"remote":true}');
    assert.equal(readFileSync(result.backups.find(b => b.path === "package-lock.json")!.backup, "utf8"), '{"local":true}');
    assert.equal(readFileSync(result.backups.find(b => b.path === "settings.json")!.backup, "utf8"), "local settings");
    assert.equal(readFileSync(join(local, "notes.txt"), "utf8"), "unrelated");
    assert.equal(git(local, ["status", "--porcelain"]).includes("ai-privacy-router-backups"), false);
  });
});
test("ignored incoming collision is preserved too", () => {
  fixture((local, advance) => {
    advance({"ignored.local": "incoming"});
    writeFileSync(join(local, "ignored.local"), "private local");
    const result = updateLocal(local, () => {});
    assert.equal(readFileSync(result.backups[0].backup, "utf8"), "private local");
    assert.equal(readFileSync(join(local, "ignored.local"), "utf8"), "incoming");
  });
});
test("tracked edits stop the update without moving local files", () => {
  fixture((local, advance, git) => {
    advance({"package-lock.json": "remote"});
    const before = git(local, ["rev-parse", "HEAD"]);
    writeFileSync(join(local, "README.md"), "local edit");
    writeFileSync(join(local, "package-lock.json"), "local lock");
    assert.throws(() => updateLocal(local, () => {}), /Tracked files have local changes/);
    assert.equal(git(local, ["rev-parse", "HEAD"]), before);
    assert.equal(readFileSync(join(local, "package-lock.json"), "utf8"), "local lock");
  });
});
test("diverged local commits and non-main branches are preserved", () => {
  fixture((local, advance, git) => {
    advance({"package-lock.json": "remote"});
    writeFileSync(join(local, "local.txt"), "local commit");
    git(local, ["add", "local.txt"]); git(local, ["commit", "-m", "Local work"]);
    const before = git(local, ["rev-parse", "HEAD"]);
    assert.throws(() => updateLocal(local, () => {}), /cannot fast-forward/);
    assert.equal(git(local, ["rev-parse", "HEAD"]), before);
    git(local, ["switch", "-c", "feature"]);
    assert.throws(() => updateLocal(local, () => {}), /Switch to main/);
    assert.equal(git(local, ["branch", "--show-current"]), "feature");
  });
});
test("failed fetch preserves an untracked lockfile", () => {
  fixture((local, _advance, git) => {
    git(local, ["remote", "set-url", "origin", join(local, "missing-remote")]);
    writeFileSync(join(local, "package-lock.json"), "local");
    assert.throws(() => updateLocal(local, () => {}), /Could not fetch/);
    assert.equal(readFileSync(join(local, "package-lock.json"), "utf8"), "local");
  });
});
test("checkout change after backup stops the merge and restores the untracked file", () => {
  fixture((local, advance, git) => {
    advance({"package-lock.json": "remote"});
    const before = git(local, ["rev-parse", "HEAD"]);
    writeFileSync(join(local, "package-lock.json"), "local");
    assert.throws(() => updateLocal(local, () => {writeFileSync(join(local, "README.md"), "concurrent edit");}), /Update stopped safely/);
    assert.equal(git(local, ["rev-parse", "HEAD"]), before);
    assert.equal(readFileSync(join(local, "package-lock.json"), "utf8"), "local");
    assert.equal(readFileSync(join(local, "README.md"), "utf8"), "concurrent edit");
  });
});
test("already-current checkout creates no backup and changes nothing", () => {
  fixture((local, _advance, git) => {
    const before = git(local, ["rev-parse", "HEAD"]);
    const result = updateLocal(local, () => {});
    assert.equal(result.head, before);
    assert.deepEqual(result.backups, []);
    assert.equal(result.backupDirectory, undefined);
    assert.equal(existsSync(join(local, ".git", "ai-privacy-router-backups")), false);
  });
});
