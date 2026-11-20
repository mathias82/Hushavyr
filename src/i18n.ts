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
  sbomDone: {en: "SBOM written to", el: "Το SBOM γράφτηκε στο"},
  dbConfirm: {en: "Download the Trivy vulnerability database? Only the public database is downloaded; no code or findings leave this machine.", el: "Λήψη της βάσης ευπαθειών του Trivy; Κατεβαίνει μόνο η δημόσια βάση, ο κώδικάς σας δεν φεύγει από τον υπολογιστή."},
  dbDownload: {en: "Download", el: "Λήψη"},
  dbDone: {en: "Trivy vulnerability database updated.", el: "Η βάση ευπαθειών του Trivy ενημερώθηκε."},
  dbFailed: {en: "Trivy database update failed. Check your network and that Trivy is installed.", el: "Η ενημέρωση της βάσης του Trivy απέτυχε. Ελέγξτε το δίκτυο και ότι το Trivy είναι εγκατεστημένο."}
} as const;
export type MessageKey = keyof typeof messages;
export function tr(language: string | undefined, key: MessageKey): string {
  return messages[key][language === "el" ? "el" : "en"];
}
