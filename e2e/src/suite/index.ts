import * as fs from "node:fs";
import * as path from "node:path";
import Mocha from "mocha";

export function run(): Promise<void> {
  const mocha = new Mocha({ui: "tdd", color: true, timeout: 30_000});
  for (const file of fs.readdirSync(__dirname).filter(name => name.endsWith(".e2e.js")).sort()) mocha.addFile(path.join(__dirname, file));
  return new Promise((resolve, reject) => {
    mocha.run(failures => failures ? reject(new Error(failures + " end-to-end test(s) failed")) : resolve());
  });
}
