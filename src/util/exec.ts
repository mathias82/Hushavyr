import {execFile} from "node:child_process";
import {promisify} from "node:util";

/** Promise-based execFile (no shell) shared by every local tool call. */
export const exec = promisify(execFile);
