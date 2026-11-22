// Downloads the public Trivy and OSV.dev CVE databases (no VS Code API). No code or dependency list leaves the machine.
import {exec} from "./exec";
import {dbIsStale, trivyDbAgeHours} from "./dependencyAudit";
import {downloadOsvDatabase, osvDbAgeHours} from "./codeScanners";
import {runs} from "./setupSteps";

const missing = (e: unknown) => (e as {code?: unknown}).code === "ENOENT";

/** Trivy (with its Java database) and OSV for each folder; a scanner that is not installed is skipped, not failed. */
export async function downloadVulnDatabases(roots: readonly string[], signal?: AbortSignal, onStep?: (name: string) => void): Promise<{done: string[]; failed: string[]}> {
  const done: string[] = [], failed: string[] = [];
  onStep?.("Trivy");
  try {
    await exec("trivy", ["image", "--download-db-only", "--quiet"], {timeout: 600000, windowsHide: true, signal});
    await exec("trivy", ["image", "--download-java-db-only", "--quiet"], {timeout: 600000, windowsHide: true, signal});
    done.push("Trivy");
  } catch (e) { if (!missing(e)) failed.push("Trivy"); }
  if (!roots.length) return {done, failed};
  onStep?.("OSV");
  try {
    for (const root of roots) await downloadOsvDatabase(root, signal);
    done.push("OSV");
  } catch (e) { if (!missing(e)) failed.push("OSV"); }
  return {done, failed};
}

/** True when an installed scanner's database is missing or over a day old. */
export async function vulnDbsStale(): Promise<boolean> {
  const [trivy, osv, hasTrivy, hasOsv] = await Promise.all([trivyDbAgeHours(), osvDbAgeHours(), runs("trivy", ["--version"]), runs("osv-scanner", ["--version"])]);
  return hasTrivy && dbIsStale(trivy) || hasOsv && dbIsStale(osv);
}
