"use strict";
const {execFileSync} = require("node:child_process");
const {existsSync, lstatSync, mkdirSync, mkdtempSync, renameSync} = require("node:fs");
const {resolve, join, dirname} = require("node:path");

function updateLocal(cwd, log = console.log) {
  const git = args => execFileSync("git", args, {
    cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"]
  });
  const root = resolve(git(["rev-parse", "--show-toplevel"]).trim());
  cwd = root;
  const gitPath = name => resolve(root, git(["rev-parse", "--git-path", name]).trim());
  const branch = () => git(["symbolic-ref", "--quiet", "--short", "HEAD"]).trim();
  const head = () => git(["rev-parse", "HEAD"]).trim();
  const clean = () => !git(["status", "--porcelain=v1", "--untracked-files=no", "--ignore-submodules=none"]).trim();
  for (const name of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"]) {
    if (existsSync(gitPath(name))) throw new Error("Finish the existing Git operation before updating.");
  }
  if (branch() !== "main") throw new Error("Switch to main before updating. No branch was changed.");
  if (!clean()) throw new Error("Tracked files have local changes. Commit or stash them before updating.");
  const before = head();
  try { git(["fetch", "--no-tags", "origin", "main"]); }
  catch { throw new Error("Could not fetch origin/main. Local files were not moved."); }
  const target = git(["rev-parse", "--verify", "FETCH_HEAD^{commit}"]).trim();
  try { git(["merge-base", "--is-ancestor", before, target]); }
  catch { throw new Error("main cannot fast-forward. Local commits were preserved; reconcile the histories first."); }
  if (before === target) return {head: before, backups: [], backupDirectory: undefined};

  const incoming = git(["ls-tree", "-r", "--name-only", "-z", target]).split("\0").filter(Boolean);
  // Include ignored files too: a local ignore rule must not hide a collision.
  const untracked = git(["ls-files", "--others", "-z"]).split("\0").filter(Boolean);
  const collides = path => incoming.some(remote => remote === path ||
    remote.startsWith(path + "/") || path.startsWith(remote + "/"));
  const collisions = untracked.filter(collides);
  let backupDirectory;
  const moved = [];
  const present = path => {
    try { lstatSync(path); return true; }
    catch (error) { if (error.code === "ENOENT") return false; throw error; }
  };
  try {
    if (collisions.length) {
      const backupRoot = gitPath("ai-privacy-router-backups");
      if (present(backupRoot)) {
        const info = lstatSync(backupRoot);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Backup directory is not a regular directory.");
      } else mkdirSync(backupRoot, {recursive: true, mode: 0o700});
      backupDirectory = mkdtempSync(join(backupRoot, "update-"));
      for (const path of collisions) {
        const source = resolve(root, path);
        const backup = resolve(backupDirectory, path);
        // Git normally guarantees relative paths; keep the filesystem boundary explicit.
        if (!source.startsWith(root + require("node:path").sep) ||
          !backup.startsWith(backupDirectory + require("node:path").sep)) throw new Error("Invalid repository path.");
        mkdirSync(dirname(backup), {recursive: true, mode: 0o700});
        renameSync(source, backup);
        moved.push({path, backup});
      }
      log("Preserved colliding untracked files in: " + backupDirectory);
    }
    if (branch() !== "main" || head() !== before || !clean()) throw new Error("Checkout changed during update.");
    // Git still protects against ignored files created after the collision scan.
    git(["merge", "--ff-only", "--no-overwrite-ignore", target]);
    return {head: head(), backups: moved, backupDirectory};
  } catch {
    let unchanged = false;
    try { unchanged = head() === before && branch() === "main"; } catch { /* keep backups */ }
    if (unchanged) {
      for (const item of [...moved].reverse()) {
        const destination = join(root, item.path);
        try {
          if (!present(destination)) {
            mkdirSync(dirname(destination), {recursive: true});
            renameSync(item.backup, destination);
          }
        } catch { /* original remains at the reported backup path */ }
      }
    }
    throw new Error("Update stopped safely. Check the working tree." +
      (backupDirectory ? " Backups or restored-file records: " + backupDirectory : ""));
  }
}

module.exports = {updateLocal};
if (require.main === module) {
  try {
    const result = updateLocal(resolve(__dirname, ".."));
    console.log("main is now at " + result.head + ".");
    console.log("Next: npm ci --ignore-scripts, npm test, npm run package:vsix.");
  } catch (error) {
    // Never print raw Git errors: remote URLs can contain credentials.
    console.error(error instanceof Error ? error.message : "Local update failed.");
    process.exitCode = 1;
  }
}
