export type UiLanguage = "en" | "el";
const messages = {
  auditHeader: {en: "Offline dependency audit:", el: "Offline έλεγχος εξαρτήσεων:"},
  ecosystem: {en: "ecosystem", el: "οικοσύστημα"},
  reported: {en: "vulnerabilities reported", el: "ευπάθειες που βρέθηκαν"},
  noCloud: {en: "No cloud requests.", el: "Καμία αποστολή στο cloud."},
  fixedIn: {en: "fixed in", el: "διορθώνεται στο"},
  noFix: {en: "no fix available", el: "δεν υπάρχει διόρθωση"},
  inFiles: {en: "in", el: "σε"},
  moreHidden: {en: "more not shown", el: "ακόμα δεν εμφανίζονται"},
  quickFix: {en: "Update to", el: "Αναβάθμιση σε"},
  dbStale: {en: "Vulnerability database is old; a clean result may be wrong. Run Hushavyr: Update Trivy Vulnerability Database.", el: "Η βάση ευπαθειών είναι παλιά, ένα καθαρό αποτέλεσμα μπορεί να είναι λάθος. Τρέξτε Hushavyr: Update Trivy Vulnerability Database."},
  dbDays: {en: "days old", el: "ημερών"},
  setupPick: {en: "Choose the local review model (downloaded automatically if missing)", el: "Επιλέξτε το τοπικό μοντέλο review (κατεβαίνει αυτόματα αν λείπει)"},
  setupRecommended: {en: "recommended for this machine's memory", el: "προτεινόμενο για τη μνήμη αυτού του υπολογιστή"},
  setupCurrent: {en: "current", el: "τρέχον"},
  setupReady: {en: "ready", el: "έτοιμο"},
  setupFailed: {en: "could not be prepared. Check Ollama and disk space. No cloud fallback.", el: "δεν ετοιμάστηκε. Ελέγξτε το Ollama και τον χώρο στον δίσκο. Καμία αποστολή στο cloud."},
  setupDone: {en: "Hushavyr setup:", el: "Ρύθμιση Hushavyr:"},
  sbomDone: {en: "SBOM written to", el: "Το SBOM γράφτηκε στο"},
  dbConfirm: {en: "Download the Trivy vulnerability database? Only the public database is downloaded; no code or findings leave this machine.", el: "Λήψη της βάσης ευπαθειών του Trivy; Κατεβαίνει μόνο η δημόσια βάση, ο κώδικάς σας δεν φεύγει από τον υπολογιστή."},
  dbDownload: {en: "Download", el: "Λήψη"},
  dbDone: {en: "Trivy vulnerability database updated.", el: "Η βάση ευπαθειών του Trivy ενημερώθηκε."},
  reachHeader: {en: "Reachability (function and import level):", el: "Χρήση στον κώδικα (επίπεδο συνάρτησης και import):"},
  reachImported: {en: "imported by your code (fix first)", el: "χρησιμοποιούνται από τον κώδικά σας (διορθώστε πρώτα)"},
  reachNotImported: {en: "not imported directly (transitive or unused, lower priority)", el: "δεν γίνονται import απευθείας (μεταβατικές ή αχρησιμοποίητες, χαμηλότερη προτεραιότητα)"},
  tagImported: {en: "used in code", el: "χρησιμοποιείται"},
  tagCalled: {en: "vulnerable function called at", el: "καλείται η ευάλωτη συνάρτηση στο"},
  tagNotImported: {en: "not imported directly", el: "δεν γίνεται import"},
  sarifDone: {en: "SARIF report written to", el: "Η αναφορά SARIF γράφτηκε στο"},
  sarifEmpty: {en: "No Hushavyr findings to export. Run /review, /security or /dependencies first.", el: "Δεν υπάρχουν ευρήματα Hushavyr για εξαγωγή. Τρέξτε πρώτα /review, /security ή /dependencies."},
  dbFailed: {en: "Trivy database update failed. Check your network and that Trivy is installed.", el: "Η ενημέρωση της βάσης του Trivy απέτυχε. Ελέγξτε το δίκτυο και ότι το Trivy είναι εγκατεστημένο."}
} as const;
export type MessageKey = keyof typeof messages;
export function tr(language: string | undefined, key: MessageKey): string {
  return messages[key][language === "el" ? "el" : "en"];
}
