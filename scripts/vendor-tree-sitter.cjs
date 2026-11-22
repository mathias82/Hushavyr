// Copies the tree-sitter WASM runtime and the grammars into dist/vendor, so the packaged extension and CLI (shipped
// without node_modules) can parse Java, JS/TS, PHP, Go, C# and Ruby. A missing file only disables that syntax tree; the
// line-based engine stays.
const {copyFileSync, existsSync, mkdirSync} = require("node:fs");
const {join} = require("node:path");

const root = join(__dirname, "..");
const out = join(root, "dist", "vendor");
const files = [
  ["web-tree-sitter/web-tree-sitter.cjs", "web-tree-sitter.cjs"],
  ["web-tree-sitter/web-tree-sitter.wasm", "web-tree-sitter.wasm"],
  ["web-tree-sitter/LICENSE", "web-tree-sitter.LICENSE"],
  ["tree-sitter-java/tree-sitter-java.wasm", "tree-sitter-java.wasm"],
  ["tree-sitter-java/LICENSE", "tree-sitter-java.LICENSE"],
  ["tree-sitter-javascript/tree-sitter-javascript.wasm", "tree-sitter-javascript.wasm"],
  ["tree-sitter-javascript/LICENSE", "tree-sitter-javascript.LICENSE"],
  ["tree-sitter-typescript/tree-sitter-typescript.wasm", "tree-sitter-typescript.wasm"],
  ["tree-sitter-typescript/tree-sitter-tsx.wasm", "tree-sitter-tsx.wasm"],
  ["tree-sitter-typescript/LICENSE", "tree-sitter-typescript.LICENSE"],
  ["tree-sitter-php/tree-sitter-php.wasm", "tree-sitter-php.wasm"],
  ["tree-sitter-php/LICENSE", "tree-sitter-php.LICENSE"],
  ["tree-sitter-go/tree-sitter-go.wasm", "tree-sitter-go.wasm"],
  ["tree-sitter-go/LICENSE", "tree-sitter-go.LICENSE"],
  ["tree-sitter-c-sharp/tree-sitter-c_sharp.wasm", "tree-sitter-c_sharp.wasm"],
  ["tree-sitter-c-sharp/LICENSE", "tree-sitter-c-sharp.LICENSE"],
  ["tree-sitter-ruby/tree-sitter-ruby.wasm", "tree-sitter-ruby.wasm"],
  ["tree-sitter-ruby/LICENSE", "tree-sitter-ruby.LICENSE"]
];
mkdirSync(out, {recursive: true});
for (const [from, to] of files) {
  const source = join(root, "node_modules", from);
  if (existsSync(source)) copyFileSync(source, join(out, to));
  else console.warn("vendor-tree-sitter: " + from + " not found; that language falls back to the line-based engine");
}
