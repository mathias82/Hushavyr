import assert from "node:assert/strict";
import {test} from "node:test";
import {diffIndex, fingerprint, parseIndex} from "../../scan/projectIndex";

test("incremental index identifies changed, unchanged and deleted files", () => {
  const old = [fingerprint("src/A.java", Buffer.from("old")), fingerprint("src/Removed.java", Buffer.from("gone"))];
  const now = [fingerprint("src/A.java", Buffer.from("new")), fingerprint("src/B.java", Buffer.from("new")),
    fingerprint("src/Unchanged.java", Buffer.from("same"))];
  const previous = [...old, fingerprint("src/Unchanged.java", Buffer.from("same"))];
  const diff = diffIndex(now, previous);
  assert.deepEqual(diff.changed.map(x => x.path), ["src/A.java", "src/B.java"]);
  assert.equal(diff.unchanged, 1);
  assert.deepEqual(diff.removed, ["src/Removed.java"]);
});
test("fingerprints are deterministic and content sensitive", () => {
  const first = fingerprint("src/A.java", Buffer.from("a"));
  assert.deepEqual(first, fingerprint("src/A.java", Buffer.from("a")));
  assert.notEqual(first.sha256, fingerprint("src/A.java", Buffer.from("b")).sha256);
  assert.match(first.sha256, /^[a-f0-9]{64}$/);
});
test("rejects malformed and oversized persisted indexes", () => {
  assert.deepEqual(parseIndex({path: "a", sha256: "x"}), []);
  assert.deepEqual(parseIndex([{path: "a", sha256: "x"}]), []);
  assert.deepEqual(parseIndex(Array.from({length: 5001}, (_, i) => ({path: String(i), sha256: "a".repeat(64)}))), []);
  assert.deepEqual(parseIndex([{path: "a", sha256: "a".repeat(64)}]), [{path: "a", sha256: "a".repeat(64)}]);
});
test("duplicate file entries fail closed", () => {
  const item = fingerprint("same.ts", Buffer.from("content"));
  assert.throws(() => diffIndex([item, item], []), /Duplicate indexed file path/);
});
test("5,000-file index diff stays bounded and accurate", () => {
  const old = Array.from({length: 5000}, (_, i) => fingerprint(`src/File${i}.java`, Buffer.from(`old-${i}`)));
  const now = old.map((item, i) => i === 4999 ? fingerprint(item.path, Buffer.from("updated")) : item);
  const diff = diffIndex(now, old);
  assert.equal(diff.changed.length, 1);
  assert.equal(diff.unchanged, 4999);
  assert.equal(diff.removed.length, 0);
});
