// Freshness of the offline CVE databases (Trivy, OSV). Only public vulnerability data is downloaded; no code or dependency list leaves the machine.
import * as vscode from "vscode";
import {exec} from "./exec";
import {dbIsStale, formatDbAge, trivyDbAgeHours} from "./dependencyAudit";
import {downloadOsvDatabase, osvDbAgeHours} from "./codeScanners";

export const UPDATE_VULN_DBS = "aiPrivacyRouter.updateVulnDbs";
const missing = (e: unknown) => (e as {code?: unknown}).code === "ENOENT";
let prompted = false;

export async function vulnDbAges(): Promise<{trivy?: number; osv?: number}> {
  return {trivy: await trivyDbAgeHours(), osv: await osvDbAgeHours()};
}

export function vulnDbStatus(ages: {trivy?: number; osv?: number}, tools: {trivy: boolean; osv: boolean}): string {
  const label = (name: string, age?: number) => name + (age === undefined ? " " : " updated ") + formatDbAge(age);
  const parts = [tools.trivy ? label("Trivy", ages.trivy) : "", tools.osv ? label("OSV", ages.osv) : ""].filter(Boolean);
  return parts.length ? "**CVE databases:** " + parts.join(" · ") + ". CVEs published after the last update are not detected.\n\n" : "";
}

/** Downloads the Trivy and OSV databases. Asks first unless `consented` (the autoUpdateVulnDb setting). */
export async function updateVulnerabilityDatabases(consented = false): Promise<boolean> {
  if (!consented) {
    const choice = await vscode.window.showWarningMessage("Hushavyr: download the latest public CVE databases (Trivy and OSV.dev)? No code or dependency list leaves this machine; scans stay offline.",
      {modal: true}, "Download");
    if (choice !== "Download") return false;
  }
  const done: string[] = [], failed: string[] = [];
  await vscode.window.withProgress({location: vscode.ProgressLocation.Notification, title: "Hushavyr: updating CVE databases", cancellable: true}, async (progress, token) => {
    const controller = new AbortController();
    const subscription = token.onCancellationRequested(() => controller.abort());
    try {
      progress.report({message: "Trivy"});
      try {
        await exec("trivy", ["image", "--download-db-only", "--quiet"], {timeout: 600000, windowsHide: true, signal: controller.signal});
        await exec("trivy", ["image", "--download-java-db-only", "--quiet"], {timeout: 600000, windowsHide: true, signal: controller.signal});
        done.push("Trivy");
      } catch (e) { if (!missing(e)) failed.push("Trivy"); }
      progress.report({message: "OSV"});
      try {
        for (const folder of vscode.workspace.workspaceFolders ?? []) if (folder.uri.scheme === "file") await downloadOsvDatabase(folder.uri.fsPath, controller.signal);
        if (vscode.workspace.workspaceFolders?.length) done.push("OSV");
      } catch (e) { if (!missing(e)) failed.push("OSV"); }
    } finally { subscription.dispose(); }
  });
  if (failed.length) void vscode.window.showErrorMessage("Hushavyr: " + failed.join(", ") + " database update failed. Check your network and that the scanner is installed.");
  else if (done.length) void vscode.window.showInformationMessage("Hushavyr: CVE databases updated (" + done.join(", ") + ").");
  else void vscode.window.showWarningMessage("Hushavyr: neither Trivy nor OSV-Scanner is installed. Run Hushavyr: Setup.");
  return done.length > 0;
}

/** Before a dependency audit: update silently when autoUpdateVulnDb is on and a database is over a day old. */
export async function autoUpdateIfStale(): Promise<void> {
  if (!vscode.workspace.getConfiguration("aiPrivacyRouter").get<boolean>("autoUpdateVulnDb", false)) return;
  const ages = await vulnDbAges();
  if (dbIsStale(ages.trivy) || dbIsStale(ages.osv)) await updateVulnerabilityDatabases(true);
}

/** After a dependency audit: offer an update once per session when a database is over a day old. */
export function offerUpdateIfStale(ages: {trivy?: number; osv?: number}, tools: {trivy: boolean; osv: boolean}): void {
  const stale = (tools.trivy && dbIsStale(ages.trivy)) || (tools.osv && dbIsStale(ages.osv));
  if (!stale || prompted) return;
  prompted = true;
  void vscode.window.showWarningMessage("Hushavyr: a CVE database is over a day old, so vulnerabilities published since then are missing.", "Update now", "Always update daily")
    .then(async choice => {
      if (choice === "Always update daily") await vscode.workspace.getConfiguration("aiPrivacyRouter").update("autoUpdateVulnDb", true, vscode.ConfigurationTarget.Global);
      if (choice) await updateVulnerabilityDatabases(choice === "Always update daily");
    });
}
