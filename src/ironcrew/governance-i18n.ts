import { useCallback } from "react";
import { useI18n } from "../i18n";

/** Static interface copy only; never apply this to user-authored content. */
export const governanceMessages: Record<string, { de: string; en: string }> = {
  Leser: {
    de: "Leser",
    en: "Viewer",
  },
  "darf lesen": {
    de: "darf lesen",
    en: "can view",
  },
  "führt die Firma": {
    de: "führt die Firma",
    en: "runs the company",
  },
  Inhaber: {
    de: "Inhaber",
    en: "Owner",
  },
  "entscheidet Freigaben": {
    de: "entscheidet Freigaben",
    en: "decides approvals",
  },
  Konto: {
    de: "Konto",
    en: "Account",
  },
  Schließen: {
    de: "Schließen",
    en: "Close",
  },
  Schliessen: {
    de: "Schliessen",
    en: "Close",
  },
  "Passwort ändern": {
    de: "Passwort ändern",
    en: "Change password",
  },
  "Passwort geändert. Andere Sitzungen wurden beendet.": {
    de: "Passwort geändert. Andere Sitzungen wurden beendet.",
    en: "Password changed. Other sessions have been ended.",
  },
  "Aktuelles Passwort": {
    de: "Aktuelles Passwort",
    en: "Current password",
  },
  "Neues Passwort": {
    de: "Neues Passwort",
    en: "New password",
  },
  Ändern: {
    de: "Ändern",
    en: "Change",
  },
  "Angemeldete Geräte": {
    de: "Angemeldete Geräte",
    en: "Signed-in devices",
  },
  "dieses Gerät": {
    de: "dieses Gerät",
    en: "this device",
  },
  unbekannt: {
    de: "unbekannt",
    en: "unknown",
  },
  "Sitzung beendet.": {
    de: "Sitzung beendet.",
    en: "Session ended.",
  },
  Abmelden: {
    de: "Abmelden",
    en: "Sign out",
  },
  Beenden: {
    de: "Beenden",
    en: "End",
  },
  Benutzer: {
    de: "Benutzer",
    en: "Users",
  },
  "Rolle geändert.": {
    de: "Rolle geändert.",
    en: "Role changed.",
  },
  gesperrt: {
    de: "gesperrt",
    en: "disabled",
  },
  "Konto gesperrt.": {
    de: "Konto gesperrt.",
    en: "Account disabled.",
  },
  "Konto entsperrt.": {
    de: "Konto entsperrt.",
    en: "Account enabled.",
  },
  Sperren: {
    de: "Sperren",
    en: "Disable",
  },
  Entsperren: {
    de: "Entsperren",
    en: "Enable",
  },
  "Neuen Benutzer anlegen": {
    de: "Neuen Benutzer anlegen",
    en: "Create user",
  },
  "Benutzer angelegt.": {
    de: "Benutzer angelegt.",
    en: "User created.",
  },
  "E-Mail": {
    de: "E-Mail",
    en: "Email",
  },
  Rolle: {
    de: "Rolle",
    en: "Role",
  },
  Passwort: {
    de: "Passwort",
    en: "Password",
  },
  Anlegen: {
    de: "Anlegen",
    en: "Create",
  },
  "Das Verzeichnis war nicht erreichbar. Melde dich mit E-Mail und Passwort an.": {
    de: "Das Verzeichnis war nicht erreichbar. Melde dich mit E-Mail und Passwort an.",
    en: "The directory could not be reached. Sign in with your email and password.",
  },
  "Das Verzeichnis hat die Anmeldung abgelehnt.": {
    de: "Das Verzeichnis hat die Anmeldung abgelehnt.",
    en: "The directory refused the sign-in.",
  },
  "Diese Anmeldung ist abgelaufen oder wurde schon verwendet. Bitte neu starten.": {
    de: "Diese Anmeldung ist abgelaufen oder wurde schon verwendet. Bitte neu starten.",
    en: "This sign-in expired or has already been used. Please start again.",
  },
  "Diese Anmeldung ist abgelaufen. Bitte neu starten.": {
    de: "Diese Anmeldung ist abgelaufen. Bitte neu starten.",
    en: "This sign-in expired. Please start again.",
  },
  "Dieses Verzeichnis-Konto ist mit keinem IronCrew-Konto verknüpft. Ein Inhaber muss es zuerst verknüpfen.": {
    de: "Dieses Verzeichnis-Konto ist mit keinem IronCrew-Konto verknüpft. Ein Inhaber muss es zuerst verknüpfen.",
    en: "This directory account is not linked to an IronCrew account. An owner must link it first.",
  },
  "Das zugehörige IronCrew-Konto ist deaktiviert.": {
    de: "Das zugehörige IronCrew-Konto ist deaktiviert.",
    en: "The linked IronCrew account is disabled.",
  },
  "Anmeldung wird geprüft …": {
    de: "Anmeldung wird geprüft …",
    en: "Checking sign-in …",
  },
  'Diese Installation hat noch keine Benutzerkonten. Das Audit-Log schreibt deshalb „ceo" statt eines Namens.': {
    de: 'Diese Installation hat noch keine Benutzerkonten. Das Audit-Log schreibt deshalb „ceo" statt eines Namens.',
    en: "This installation has no user accounts yet. The audit log therefore records “ceo” instead of a name.",
  },
  "Ersten Inhaber anlegen": {
    de: "Ersten Inhaber anlegen",
    en: "Create first owner",
  },
  "Wird angelegt …": {
    de: "Wird angelegt …",
    en: "Creating …",
  },
  "Inhaber anlegen": {
    de: "Inhaber anlegen",
    en: "Create owner",
  },
  "Anmelden …": {
    de: "Anmelden …",
    en: "Signing in …",
  },
  Anmelden: {
    de: "Anmelden",
    en: "Sign in",
  },
  "Die Anmeldung über das Verzeichnis ist fehlgeschlagen.": {
    de: "Die Anmeldung über das Verzeichnis ist fehlgeschlagen.",
    en: "Directory sign-in failed.",
  },
  "Mit dem Verzeichnis anmelden": {
    de: "Mit dem Verzeichnis anmelden",
    en: "Sign in with the directory",
  },
  Gewerke: {
    de: "Gewerke",
    en: "Business packs",
  },
  "Die Anfrage konnte nicht abgeschlossen werden.": {
    de: "Die Anfrage konnte nicht abgeschlossen werden.",
    en: "The request could not be completed.",
  },
  "Der Serverstand oder die zentrale Policy wurde geändert. Dein Entwurf bleibt erhalten. Lade den aktuellen Serverstand und vergleiche die Freigaben.":
    {
      de: "Der Serverstand oder die zentrale Policy wurde geändert. Dein Entwurf bleibt erhalten. Lade den aktuellen Serverstand und vergleiche die Freigaben.",
      en: "The server state or central policy changed. Your draft has been preserved. Load the current server state and compare permissions.",
    },
  "Vendor- und Provider-Freigaben": {
    de: "Vendor- und Provider-Freigaben",
    en: "Vendor and provider permissions",
  },
  "Vendor- &amp; Provider-Freigaben": {
    de: "Vendor- & Provider-Freigaben",
    en: "Vendor & provider permissions",
  },
  "Lege fest, welche Modellfamilien und OpenRouter-Provider deine Firma verwenden darf.": {
    de: "Lege fest, welche Modellfamilien und OpenRouter-Provider deine Firma verwenden darf.",
    en: "Choose which model families and OpenRouter providers your company may use.",
  },
  "Serverstand laden": {
    de: "Serverstand laden",
    en: "Load server state",
  },
  "Leseansicht: Nur der Owner kann Freigaben ändern.": {
    de: "Leseansicht: Nur der Owner kann Freigaben ändern.",
    en: "Read-only: only the owner can change permissions.",
  },
  "Freigaben werden geladen …": {
    de: "Freigaben werden geladen …",
    en: "Loading permissions …",
  },
  "Die Freigaben sind noch nicht verfügbar. Lade den Serverstand erneut.": {
    de: "Die Freigaben sind noch nicht verfügbar. Lade den Serverstand erneut.",
    en: "Permissions are not available yet. Reload the server state.",
  },
  "Zentrale Schutzregeln": {
    de: "Zentrale Schutzregeln",
    en: "Central safeguards",
  },
  "Fest vorgegeben": {
    de: "Fest vorgegeben",
    en: "Fixed rules",
  },
  "Die zentrale Policy begrenzt alle Freigaben. Diese Ansicht kann ihre Sperren, Datenschutzregeln und Telemetrie-Einstellungen nicht ändern.":
    {
      de: "Die zentrale Policy begrenzt alle Freigaben. Diese Ansicht kann ihre Sperren, Datenschutzregeln und Telemetrie-Einstellungen nicht ändern.",
      en: "The central policy limits all permissions. This view cannot change its blocks, privacy rules or telemetry settings.",
    },
  "Gesperrte Modellfamilien (": {
    de: "Gesperrte Modellfamilien (",
    en: "Blocked model families (",
  },
  "Gesperrte Dienste (": {
    de: "Gesperrte Dienste (",
    en: "Blocked services (",
  },
  "OpenRouter-Fallback": {
    de: "OpenRouter-Fallback",
    en: "OpenRouter fallback",
  },
  "Innerhalb der Provider-Freigaben": {
    de: "Innerhalb der Provider-Freigaben",
    en: "Within provider permissions",
  },
  "Sensible Aufgaben": {
    de: "Sensible Aufgaben",
    en: "Sensitive tasks",
  },
  "Datensammlung:": {
    de: "Datensammlung:",
    en: "Data collection:",
  },
  "nicht vorgeschrieben": {
    de: "nicht vorgeschrieben",
    en: "not required",
  },
  "innerhalb der Provider-Freigaben": {
    de: "innerhalb der Provider-Freigaben",
    en: "within provider permissions",
  },
  Telemetrie: {
    de: "Telemetrie",
    en: "Telemetry",
  },
  "In zentraler Policy aktiviert": {
    de: "In zentraler Policy aktiviert",
    en: "Enabled in the central policy",
  },
  "Geladener Serverstand": {
    de: "Geladener Serverstand",
    en: "Loaded server state",
  },
  "Der Entwurf basiert auf Revision": {
    de: "Der Entwurf basiert auf Revision",
    en: "The draft is based on revision",
  },
  ". Der geladene Serverstand (Revision": {
    de: ". Der geladene Serverstand (Revision",
    en: ". The loaded server state (revision",
  },
  ") oder seine zentrale Policy ist neuer. Deine Auswahl und Begründung bleiben erhalten.": {
    de: ") oder seine zentrale Policy ist neuer. Deine Auswahl und Begründung bleiben erhalten.",
    en: ") or its central policy is newer. Your selection and reason have been preserved.",
  },
  "Aktive Modellfamilien:": {
    de: "Aktive Modellfamilien:",
    en: "Active model families:",
  },
  "Aktive OpenRouter-Provider:": {
    de: "Aktive OpenRouter-Provider:",
    en: "Active OpenRouter providers:",
  },
  "Erneutes Speichern übernimmt deine vollständige Auswahl als neue Firmenfreigabe.": {
    de: "Erneutes Speichern übernimmt deine vollständige Auswahl als neue Firmenfreigabe.",
    en: "Saving again applies your full selection as the new company permissions.",
  },
  "Dein Entwurf basiert jetzt auf dem geladenen Stand. Prüfe die Auswahl vor dem Speichern erneut.": {
    de: "Dein Entwurf basiert jetzt auf dem geladenen Stand. Prüfe die Auswahl vor dem Speichern erneut.",
    en: "Your draft is now based on the loaded state. Review your selection before saving.",
  },
  "Entwurf auf geladenem Stand weiterbearbeiten": {
    de: "Entwurf auf geladenem Stand weiterbearbeiten",
    en: "Continue draft on loaded state",
  },
  "Geladener Serverstand übernommen. Der Entwurf wurde verworfen.": {
    de: "Geladener Serverstand übernommen. Der Entwurf wurde verworfen.",
    en: "Loaded server state applied. The draft was discarded.",
  },
  "Entwurf verwerfen und Serverstand übernehmen": {
    de: "Entwurf verwerfen und Serverstand übernehmen",
    en: "Discard draft and apply server state",
  },
  "Gilt auch für CLI-Runtimes und Routing-Fallbacks.": {
    de: "Gilt auch für CLI-Runtimes und Routing-Fallbacks.",
    en: "Also applies to CLI runtimes and routing fallbacks.",
  },
  "Gilt für die ausführenden Anbieter hinter OpenRouter.": {
    de: "Gilt für die ausführenden Anbieter hinter OpenRouter.",
    en: "Applies to the providers executing requests through OpenRouter.",
  },
  "Alle Modelle": {
    de: "Alle Modelle",
    en: "All models",
  },
  "Alle Anbieter": {
    de: "Alle Anbieter",
    en: "All providers",
  },
  " — gespeicherte Einschränkung": {
    de: " — gespeicherte Einschränkung",
    en: " — saved restriction",
  },
  " — zentral nicht mehr erlaubt; Auswahl entfernen": {
    de: " — zentral nicht mehr erlaubt; Auswahl entfernen",
    en: " — no longer allowed centrally; remove selection",
  },
  "Die zentrale Policy gibt keine Einträge frei.": {
    de: "Die zentrale Policy gibt keine Einträge frei.",
    en: "The central policy does not permit any entries.",
  },
  "Vorschau der Freigaben": {
    de: "Vorschau der Freigaben",
    en: "Permissions preview",
  },
  "Vorschau deines Entwurfs": {
    de: "Vorschau deines Entwurfs",
    en: "Draft preview",
  },
  "Aktive Freigaben": {
    de: "Aktive Freigaben",
    en: "Active permissions",
  },
  "Noch nicht gespeichert. ": {
    de: "Noch nicht gespeichert. ",
    en: "Not saved yet. ",
  },
  "Modellfamilien:": {
    de: "Modellfamilien:",
    en: "Model families:",
  },
  "OpenRouter-Provider:": {
    de: "OpenRouter-Provider:",
    en: "OpenRouter providers:",
  },
  "Keine Modellfamilie ausgewählt: Alle Modellanfragen werden blockiert.": {
    de: "Keine Modellfamilie ausgewählt: Alle Modellanfragen werden blockiert.",
    en: "No model family selected: all model requests will be blocked.",
  },
  "Kein Provider ausgewählt: OpenRouter-Anfragen werden blockiert.": {
    de: "Kein Provider ausgewählt: OpenRouter-Anfragen werden blockiert.",
    en: "No provider selected: OpenRouter requests will be blocked.",
  },
  "Entferne die Auswahlen, die in der zentralen Policy nicht mehr erlaubt sind.": {
    de: "Entferne die Auswahlen, die in der zentralen Policy nicht mehr erlaubt sind.",
    en: "Remove selections that the central policy no longer allows.",
  },
  "Zentrale Sperren haben immer Vorrang. Eine Freigabe bestätigt keine Modellverfügbarkeit, Anmeldung oder ausreichendes Budget.":
    {
      de: "Zentrale Sperren haben immer Vorrang. Eine Freigabe bestätigt keine Modellverfügbarkeit, Anmeldung oder ausreichendes Budget.",
      en: "Central blocks always take precedence. Permission does not confirm model availability, authentication or sufficient budget.",
    },
  "Begründung der Änderung": {
    de: "Begründung der Änderung",
    en: "Reason for the change",
  },
  "Mindestens 10 Zeichen. Die Begründung wird mit deiner Identität in Verlauf und Audit gespeichert.": {
    de: "Mindestens 10 Zeichen. Die Begründung wird mit deiner Identität in Verlauf und Audit gespeichert.",
    en: "At least 10 characters. The reason is saved with your identity in the history and audit log.",
  },
  "Freigaben werden gespeichert …": {
    de: "Freigaben werden gespeichert …",
    en: "Saving permissions …",
  },
  "Freigaben speichern": {
    de: "Freigaben speichern",
    en: "Save permissions",
  },
  "Modell prüfen": {
    de: "Modell prüfen",
    en: "Check model",
  },
  "Modell gegen gespeicherte Freigaben prüfen": {
    de: "Modell gegen gespeicherte Freigaben prüfen",
    en: "Check model against saved permissions",
  },
  "Prüft ausschließlich den gespeicherten Serverstand. Dabei wird kein Modell gestartet und kein Provider kontaktiert.":
    {
      de: "Prüft ausschließlich den gespeicherten Serverstand. Dabei wird kein Modell gestartet und kein Provider kontaktiert.",
      en: "Checks only the saved server state. No model is started and no provider is contacted.",
    },
  "Ohne Provider wird nur die Modellfamilie geprüft. Für OpenRouter zusätzlich den konkreten Provider angeben.": {
    de: "Ohne Provider wird nur die Modellfamilie geprüft. Für OpenRouter zusätzlich den konkreten Provider angeben.",
    en: "Without a provider, only the model family is checked. For OpenRouter, also enter the specific provider.",
  },
  "Modell-ID": {
    de: "Modell-ID",
    en: "Model ID",
  },
  "anbieter/modell": {
    de: "anbieter/modell",
    en: "provider/model",
  },
  "Provider (optional)": {
    de: "Provider (optional)",
    en: "Provider (optional)",
  },
  "Name des OpenRouter-Providers": {
    de: "Name des OpenRouter-Providers",
    en: "OpenRouter provider name",
  },
  "Modell wird geprüft …": {
    de: "Modell wird geprüft …",
    en: "Checking model …",
  },
  "Gespeicherte Policy prüfen": {
    de: "Gespeicherte Policy prüfen",
    en: "Check saved policy",
  },
  "(geprüfte Revision": {
    de: "(geprüfte Revision",
    en: "(checked revision",
  },
  "Änderungsverlauf (": {
    de: "Änderungsverlauf (",
    en: "Change history (",
  },
  "Noch keine Firmenänderung gespeichert. Es gelten die zentralen Freigaben.": {
    de: "Noch keine Firmenänderung gespeichert. Es gelten die zentralen Freigaben.",
    en: "No company changes saved yet. Central permissions apply.",
  },
  "Familien:": {
    de: "Familien:",
    en: "Families:",
  },
  "· Korrelation:": {
    de: "· Korrelation:",
    en: "· Correlation:",
  },
  Werkzeugaufrufe: {
    de: "Werkzeugaufrufe",
    en: "Tool calls",
  },
  "Session fortsetzen": {
    de: "Session fortsetzen",
    en: "Resume session",
  },
  Bildverarbeitung: {
    de: "Bildverarbeitung",
    en: "Vision",
  },
  "Langer Kontext": {
    de: "Langer Kontext",
    en: "Long context",
  },
  Intern: {
    de: "Intern",
    en: "Internal",
  },
  Vertraulich: {
    de: "Vertraulich",
    en: "Confidential",
  },
  "Die Routing-Einstellungen konnten nicht gespeichert werden.": {
    de: "Die Routing-Einstellungen konnten nicht gespeichert werden.",
    en: "The routing settings could not be saved.",
  },
  ": Modell": {
    de: ": Modell",
    en: ": Model",
  },
  ": Vendor-Modell": {
    de: ": Vendor-Modell",
    en: ": Vendor model",
  },
  "Kein Ziel konfiguriert": {
    de: "Kein Ziel konfiguriert",
    en: "No target configured",
  },
  "Exakte Modell-ID oder CLI-Alias": {
    de: "Exakte Modell-ID oder CLI-Alias",
    en: "Exact model ID or CLI alias",
  },
  "Anbieter/Modell für die Vendor-Policy": {
    de: "Anbieter/Modell für die Vendor-Policy",
    en: "Provider/model for the vendor policy",
  },
  "Die Runtime erhält das Modell exakt als Argument. Bei Modell-IDs mit „/“ muss das Vendor-Modell identisch sein. CLI-Aliase verwenden ausschließlich den festen Anbieterpräfix: Claude → anthropic/, Codex → openai/, Google → google/.":
    {
      de: "Die Runtime erhält das Modell exakt als Argument. Bei Modell-IDs mit „/“ muss das Vendor-Modell identisch sein. CLI-Aliase verwenden ausschließlich den festen Anbieterpräfix: Claude → anthropic/, Codex → openai/, Google → google/.",
      en: "The runtime receives the exact model as an argument. Model IDs containing “/” must match the vendor model. CLI aliases use only the fixed provider prefix: Claude → anthropic/, Codex → openai/, Google → google/.",
    },
  "Aktueller Serverstand geladen. Lokale Änderungen wurden verworfen.": {
    de: "Aktueller Serverstand geladen. Lokale Änderungen wurden verworfen.",
    en: "Current server state loaded. Local changes were discarded.",
  },
  "Routing-Profile gespeichert. Die neue Konfiguration gilt für folgende Runs.": {
    de: "Routing-Profile gespeichert. Die neue Konfiguration gilt für folgende Runs.",
    en: "Routing profiles saved. The new configuration applies to subsequent runs.",
  },
  "Der Serverstand wurde zwischenzeitlich geändert. Dein Entwurf bleibt erhalten. Lade den aktuellen Stand, bevor du ihn erneut bearbeitest.":
    {
      de: "Der Serverstand wurde zwischenzeitlich geändert. Dein Entwurf bleibt erhalten. Lade den aktuellen Stand, bevor du ihn erneut bearbeitest.",
      en: "The server state changed in the meantime. Your draft has been preserved. Load the current state before editing it again.",
    },
  "Profil dem Agenten zugeordnet.": {
    de: "Profil dem Agenten zugeordnet.",
    en: "Profile assigned to the agent.",
  },
  "Profilzuordnung entfernt. Der Agent verwendet wieder sein bestehendes Vessel.": {
    de: "Profilzuordnung entfernt. Der Agent verwendet wieder sein bestehendes Vessel.",
    en: "Profile assignment removed. The agent will use its existing vessel again.",
  },
  "Modellprofile und Routing": {
    de: "Modellprofile und Routing",
    en: "Model profiles and routing",
  },
  "Modellprofile &amp; Routing": {
    de: "Modellprofile & Routing",
    en: "Model profiles & routing",
  },
  "Runtimes und Modelle bewusst zuordnen. Fallbacks bleiben an Datenschutz, Fähigkeiten und Vendor-Policy gebunden.": {
    de: "Runtimes und Modelle bewusst zuordnen. Fallbacks bleiben an Datenschutz, Fähigkeiten und Vendor-Policy gebunden.",
    en: "Assign runtimes and models explicitly. Fallbacks remain subject to privacy, capability and vendor policy requirements.",
  },
  "Serverstand prüfen": {
    de: "Serverstand prüfen",
    en: "Check server state",
  },
  "Leseansicht: Nur der Owner kann Profile und Zuordnungen ändern.": {
    de: "Leseansicht: Nur der Owner kann Profile und Zuordnungen ändern.",
    en: "Read-only: only the owner can change profiles and assignments.",
  },
  "Routing-Konfiguration wird geladen …": {
    de: "Routing-Konfiguration wird geladen …",
    en: "Loading routing configuration …",
  },
  "Auf dem Server liegt Revision": {
    de: "Auf dem Server liegt Revision",
    en: "The server has revision",
  },
  "; dein Entwurf basiert auf Revision": {
    de: "; dein Entwurf basiert auf Revision",
    en: "; your draft is based on revision",
  },
  "Die Routing-Konfiguration ist noch nicht verfügbar. Über „Serverstand prüfen“ erneut laden.": {
    de: "Die Routing-Konfiguration ist noch nicht verfügbar. Über „Serverstand prüfen“ erneut laden.",
    en: "The routing configuration is not available yet. Reload it with “Check server state”.",
  },
  "Routing-Profile": {
    de: "Routing-Profile",
    en: "Routing profiles",
  },
  Profilbezeichnung: {
    de: "Profilbezeichnung",
    en: "Profile name",
  },
  Primärziel: {
    de: "Primärziel",
    en: "Primary target",
  },
  "Noch nicht konfiguriert. Dieses Profil startet keinen Run. Wähle ein Vessel und ein konkretes Modell.": {
    de: "Noch nicht konfiguriert. Dieses Profil startet keinen Run. Wähle ein Vessel und ein konkretes Modell.",
    en: "Not configured yet. This profile will not start a run. Choose a vessel and a specific model.",
  },
  "Automatischen Fallback ausdrücklich erlauben": {
    de: "Automatischen Fallback ausdrücklich erlauben",
    en: "Explicitly allow automatic fallback",
  },
  "Gespeicherte Ersatzziele werden ausschließlich in dieser Reihenfolge und nach erneuter Policy-Prüfung verwendet. Ohne Freigabe erfolgt kein automatischer Wechsel.":
    {
      de: "Gespeicherte Ersatzziele werden ausschließlich in dieser Reihenfolge und nach erneuter Policy-Prüfung verwendet. Ohne Freigabe erfolgt kein automatischer Wechsel.",
      en: "Saved fallback targets are used only in this order and after another policy check. No automatic switch occurs without permission.",
    },
  "Nach oben": {
    de: "Nach oben",
    en: "Move up",
  },
  "Nach unten": {
    de: "Nach unten",
    en: "Move down",
  },
  Entfernen: {
    de: "Entfernen",
    en: "Remove",
  },
  "Fallback hinzufügen": {
    de: "Fallback hinzufügen",
    en: "Add fallback",
  },
  "Erlaubte Sensitivität": {
    de: "Erlaubte Sensitivität",
    en: "Allowed sensitivity",
  },
  "Erforderliche Fähigkeiten": {
    de: "Erforderliche Fähigkeiten",
    en: "Required capabilities",
  },
  "Nicht gemeldete Fähigkeiten gelten als nicht verfügbar. Ein Ziel ohne alle geforderten Fähigkeiten wird abgelehnt.":
    {
      de: "Nicht gemeldete Fähigkeiten gelten als nicht verfügbar. Ein Ziel ohne alle geforderten Fähigkeiten wird abgelehnt.",
      en: "Unreported capabilities are treated as unavailable. A target without all required capabilities is rejected.",
    },
  "Alle Routing-Profile speichern": {
    de: "Alle Routing-Profile speichern",
    en: "Save all routing profiles",
  },
  "Serverstand laden und Entwurf verwerfen": {
    de: "Serverstand laden und Entwurf verwerfen",
    en: "Load server state and discard draft",
  },
  "Mindestens ein Profil ist unvollständig: Ziele, Modelle, eindeutige Fallbacks und Sensitivität prüfen.": {
    de: "Mindestens ein Profil ist unvollständig: Ziele, Modelle, eindeutige Fallbacks und Sensitivität prüfen.",
    en: "At least one profile is incomplete: check targets, models, unique fallbacks and sensitivity.",
  },
  "Profilzuordnung der Agents": {
    de: "Profilzuordnung der Agents",
    en: "Agent profile assignments",
  },
  "Profile den Agents zuordnen": {
    de: "Profile den Agents zuordnen",
    en: "Assign profiles to agents",
  },
  "Ohne Profilzuordnung bleibt das bestehende Vessel des Agenten zuständig. Ein unkonfiguriertes Profil erlaubt keine Ausführung.":
    {
      de: "Ohne Profilzuordnung bleibt das bestehende Vessel des Agenten zuständig. Ein unkonfiguriertes Profil erlaubt keine Ausführung.",
      en: "Without a profile assignment, the agent's existing vessel remains responsible. An unconfigured profile does not allow execution.",
    },
  "Routingprofil für": {
    de: "Routingprofil für",
    en: "Routing profile for",
  },
  "Bestehendes Vessel verwenden": {
    de: "Bestehendes Vessel verwenden",
    en: "Use existing vessel",
  },
  " · nicht konfiguriert": {
    de: " · nicht konfiguriert",
    en: " · not configured",
  },
  "Zuordnung speichern": {
    de: "Zuordnung speichern",
    en: "Save assignment",
  },
  "Noch keine Agents vorhanden.": {
    de: "Noch keine Agents vorhanden.",
    en: "No agents yet.",
  },
  "Versionshistorie (": {
    de: "Versionshistorie (",
    en: "Version history (",
  },
  "Noch keine gespeicherten Änderungen.": {
    de: "Noch keine gespeicherten Änderungen.",
    en: "No saved changes yet.",
  },
  Laufzeiten: {
    de: "Laufzeiten",
    en: "Runtimes",
  },
  Freigaben: {
    de: "Freigaben",
    en: "Approvals",
  },
  Lesen: {
    de: "Lesen",
    en: "Read",
  },
  Schreiben: {
    de: "Schreiben",
    en: "Write",
  },
  "Externe Aktion": {
    de: "Externe Aktion",
    en: "External action",
  },
  "Der Serverstand wurde geändert. Dein Entwurf bleibt erhalten. Lade den aktuellen Stand und vergleiche die Änderungen.":
    {
      de: "Der Serverstand wurde geändert. Dein Entwurf bleibt erhalten. Lade den aktuellen Stand und vergleiche die Änderungen.",
      en: "The server state changed. Your draft has been preserved. Load the current state and compare the changes.",
    },
  Firmenkonfiguration: {
    de: "Firmenkonfiguration",
    en: "Company configuration",
  },
  "Arbeitsgrenzen, Freigaben und Kontext für deine Crew.": {
    de: "Arbeitsgrenzen, Freigaben und Kontext für deine Crew.",
    en: "Work limits, approvals and context for your crew.",
  },
  "Konfiguration wird geladen …": {
    de: "Konfiguration wird geladen …",
    en: "Loading configuration …",
  },
  "Leseansicht: Nur der bestätigte Owner kann die Firmenkonfiguration ändern.": {
    de: "Leseansicht: Nur der bestätigte Owner kann die Firmenkonfiguration ändern.",
    en: "Read-only: only the verified owner can change company configuration.",
  },
  "Die Vendor-Policy und verpflichtende Freigaben bleiben verbindlich. Diese Einstellungen erteilen keine zusätzlichen Tool- oder Netzwerkrechte.":
    {
      de: "Die Vendor-Policy und verpflichtende Freigaben bleiben verbindlich. Diese Einstellungen erteilen keine zusätzlichen Tool- oder Netzwerkrechte.",
      en: "The vendor policy and mandatory approvals remain binding. These settings do not grant additional tool or network permissions.",
    },
  Konfigurationsbereiche: {
    de: "Konfigurationsbereiche",
    en: "Configuration sections",
  },
  bearbeiten: {
    de: "bearbeiten",
    en: "settings",
  },
  "Firmenweite Obergrenzen. Strengere Grenzen einzelner Runtime-Profile gelten weiterhin.": {
    de: "Firmenweite Obergrenzen. Strengere Grenzen einzelner Runtime-Profile gelten weiterhin.",
    en: "Company-wide limits. Stricter limits of individual runtime profiles still apply.",
  },
  "Maximale parallele Runs": {
    de: "Maximale parallele Runs",
    en: "Maximum parallel runs",
  },
  "Maximale Laufzeit (Sekunden)": {
    de: "Maximale Laufzeit (Sekunden)",
    en: "Maximum duration (seconds)",
  },
  "Änderungen gelten für folgende Run-Starts. Bereits laufende Prozesse werden dadurch nicht beendet.": {
    de: "Änderungen gelten für folgende Run-Starts. Bereits laufende Prozesse werden dadurch nicht beendet.",
    en: "Changes apply to subsequent run starts. They do not terminate processes already running.",
  },
  "Erweitere die Freigabepflicht um zusätzliche Aktionstypen. Die festen Schutzregeln können hier nicht aufgehoben werden.":
    {
      de: "Erweitere die Freigabepflicht um zusätzliche Aktionstypen. Die festen Schutzregeln können hier nicht aufgehoben werden.",
      en: "Require approval for additional action types. The fixed safeguards cannot be removed here.",
    },
  "Zusätzlich freigabepflichtige Aktionen": {
    de: "Zusätzlich freigabepflichtige Aktionen",
    en: "Additional actions requiring approval",
  },
  "Es sind noch keine zusätzlichen Tools registriert.": {
    de: "Es sind noch keine zusätzlichen Tools registriert.",
    en: "No additional tools registered yet.",
  },
  "Immer freigabepflichtig (": {
    de: "Immer freigabepflichtig (",
    en: "Always requires approval (",
  },
  "Gesperrte Tools bleiben auch dann gesperrt, wenn ein Mitarbeiter sie ansonsten verwenden dürfte.": {
    de: "Gesperrte Tools bleiben auch dann gesperrt, wenn ein Mitarbeiter sie ansonsten verwenden dürfte.",
    en: "Blocked tools remain blocked even if an employee would otherwise be allowed to use them.",
  },
  "Tools sperren": {
    de: "Tools sperren",
    en: "Block tools",
  },
  "Es sind noch keine Tools registriert.": {
    de: "Es sind noch keine Tools registriert.",
    en: "No tools registered yet.",
  },
  "Zusätzliche Freigaben nach Risikoklasse": {
    de: "Zusätzliche Freigaben nach Risikoklasse",
    en: "Additional approvals by risk class",
  },
  "Freigabe für": {
    de: "Freigabe für",
    en: "Approval for",
  },
  "Steuere den Kontextabruf für kommende Runs. Gespeichertes Wissen wird beim Ausschalten nicht gelöscht.": {
    de: "Steuere den Kontextabruf für kommende Runs. Gespeichertes Wissen wird beim Ausschalten nicht gelöscht.",
    en: "Control context retrieval for upcoming runs. Turning it off does not delete saved knowledge.",
  },
  "Memory-Kontext für Runs verwenden": {
    de: "Memory-Kontext für Runs verwenden",
    en: "Use memory context for runs",
  },
  "Maximale Kontext-Einträge": {
    de: "Maximale Kontext-Einträge",
    en: "Maximum context entries",
  },
  "Optionale semantische Suche verwenden": {
    de: "Optionale semantische Suche verwenden",
    en: "Use optional semantic search",
  },
  "Externe Memory-Dienste müssen zusätzlich eingerichtet sein. Diese Auswahl richtet keinen Dienst ein und überträgt keine Zugangsdaten.":
    {
      de: "Externe Memory-Dienste müssen zusätzlich eingerichtet sein. Diese Auswahl richtet keinen Dienst ein und überträgt keine Zugangsdaten.",
      en: "External memory services must also be configured. This option does not set up a service or transfer credentials.",
    },
  "Prüfe die Eingaben: parallele Runs 1–64, Laufzeit 1–86.400 Sekunden, Kontext-Einträge 1–30 und gültige, eindeutige Aktionstypen.":
    {
      de: "Prüfe die Eingaben: parallele Runs 1–64, Laufzeit 1–86.400 Sekunden, Kontext-Einträge 1–30 und gültige, eindeutige Aktionstypen.",
      en: "Check the inputs: 1–64 parallel runs, 1–86,400 seconds duration, 1–30 context entries, and valid, unique action types.",
    },
  "Dein Entwurf basiert auf Revision": {
    de: "Dein Entwurf basiert auf Revision",
    en: "Your draft is based on revision",
  },
  "; geladen ist Revision": {
    de: "; geladen ist Revision",
    en: "; the loaded revision is",
  },
  ". Vergleiche die Werte vor dem erneuten Speichern.": {
    de: ". Vergleiche die Werte vor dem erneuten Speichern.",
    en: ". Compare the values before saving again.",
  },
  "Aktuelle Serverwerte vergleichen": {
    de: "Aktuelle Serverwerte vergleichen",
    en: "Compare current server values",
  },
  "Der Entwurf verwendet jetzt die geladene Revision. Prüfe alle Werte vor dem Speichern.": {
    de: "Der Entwurf verwendet jetzt die geladene Revision. Prüfe alle Werte vor dem Speichern.",
    en: "The draft now uses the loaded revision. Review all values before saving.",
  },
  "Entwurf verwerfen": {
    de: "Entwurf verwerfen",
    en: "Discard draft",
  },
  "Mindestens 10 Zeichen. Die Begründung wird mit Owner, Zeitpunkt und Revision im Audit gespeichert.": {
    de: "Mindestens 10 Zeichen. Die Begründung wird mit Owner, Zeitpunkt und Revision im Audit gespeichert.",
    en: "At least 10 characters. The reason is saved with the owner, time and revision in the audit log.",
  },
  "Wird gespeichert …": {
    de: "Wird gespeichert …",
    en: "Saving …",
  },
  "Konfiguration speichern": {
    de: "Konfiguration speichern",
    en: "Save configuration",
  },
  "Ungespeicherter Entwurf": {
    de: "Ungespeicherter Entwurf",
    en: "Unsaved draft",
  },
  "Noch keine Änderungen. Es gelten die Ausgangswerte.": {
    de: "Noch keine Änderungen. Es gelten die Ausgangswerte.",
    en: "No changes yet. Default values apply.",
  },
  "Gespeicherte Werte und Audit-Bezug": {
    de: "Gespeicherte Werte und Audit-Bezug",
    en: "Saved values and audit reference",
  },
  "Korrelation:": {
    de: "Korrelation:",
    en: "Correlation:",
  },
  "Die Konfiguration ist nicht verfügbar. Lade den Serverstand erneut.": {
    de: "Die Konfiguration ist nicht verfügbar. Lade den Serverstand erneut.",
    en: "The configuration is unavailable. Reload the server state.",
  },
  "Guidance enthält Text": {
    de: "Guidance enthält Text",
    en: "Guidance contains text",
  },
  "Guidance vermeidet Text": {
    de: "Guidance vermeidet Text",
    en: "Guidance excludes text",
  },
  "Installierte Skill-Referenz gewählt": {
    de: "Installierte Skill-Referenz gewählt",
    en: "Installed skill reference selected",
  },
  "Gespeicherter Run abgeschlossen": {
    de: "Gespeicherter Run abgeschlossen",
    en: "Saved run completed",
  },
  "Gespeichertes Ergebnis enthält Text": {
    de: "Gespeichertes Ergebnis enthält Text",
    en: "Saved output contains text",
  },
  Retrospektive: {
    de: "Retrospektive",
    en: "Retrospective",
  },
  Entwurf: {
    de: "Entwurf",
    en: "Draft",
  },
  "Bereit zur Freigabe": {
    de: "Bereit zur Freigabe",
    en: "Ready for approval",
  },
  "Prüfung fehlgeschlagen": {
    de: "Prüfung fehlgeschlagen",
    en: "Evaluation failed",
  },
  Übernommen: {
    de: "Übernommen",
    en: "Applied",
  },
  Abgelehnt: {
    de: "Abgelehnt",
    en: "Rejected",
  },
  "Coaching konnte nicht geladen werden.": {
    de: "Coaching konnte nicht geladen werden.",
    en: "Coaching could not be loaded.",
  },
  "Die Änderung konnte nicht gespeichert werden.": {
    de: "Die Änderung konnte nicht gespeichert werden.",
    en: "The change could not be saved.",
  },
  "Vorschlag gespeichert. Jetzt auswerten und anschließend menschlich prüfen.": {
    de: "Vorschlag gespeichert. Jetzt auswerten und anschließend menschlich prüfen.",
    en: "Proposal saved. Evaluate it, then have a person review it.",
  },
  "Neue Guidance-Version freigegeben. Sie gilt ab dem nächsten Run.": {
    de: "Neue Guidance-Version freigegeben. Sie gilt ab dem nächsten Run.",
    en: "New guidance version approved. It applies from the next run.",
  },
  "Vorschlag abgelehnt. Die aktive Guidance bleibt bestehen.": {
    de: "Vorschlag abgelehnt. Die aktive Guidance bleibt bestehen.",
    en: "Proposal rejected. The active guidance remains unchanged.",
  },
  "Coaching und Evaluationen": {
    de: "Coaching und Evaluationen",
    en: "Coaching and evaluations",
  },
  "Coaching &amp; Evaluationen": {
    de: "Coaching & Evaluationen",
    en: "Coaching & evaluations",
  },
  "Konkrete Beobachtungen festhalten, Änderungen prüfen und bewusst freigeben.": {
    de: "Konkrete Beobachtungen festhalten, Änderungen prüfen und bewusst freigeben.",
    en: "Record concrete observations, evaluate changes and approve them deliberately.",
  },
  "Coaching-Verlauf wird geladen …": {
    de: "Coaching-Verlauf wird geladen …",
    en: "Loading coaching history …",
  },
  "Noch keine Agenten vorhanden.": {
    de: "Noch keine Agenten vorhanden.",
    en: "No agents yet.",
  },
  "Erneut laden": {
    de: "Erneut laden",
    en: "Reload",
  },
  "Aktive Guidance · Version": {
    de: "Aktive Guidance · Version",
    en: "Active guidance · Version",
  },
  "Es gilt die bestehende professionelle Rolle. Noch keine Coaching-Ergänzung freigegeben.": {
    de: "Es gilt die bestehende professionelle Rolle. Noch keine Coaching-Ergänzung freigegeben.",
    en: "The existing professional role applies. No coaching addition has been approved yet.",
  },
  "Skill-Referenzen:": {
    de: "Skill-Referenzen:",
    en: "Skill references:",
  },
  "Guidance ergänzt die Arbeitsweise. Sie ändert keine Rolle, Persona, Tools, Berechtigungen oder Seniorität.": {
    de: "Guidance ergänzt die Arbeitsweise. Sie ändert keine Rolle, Persona, Tools, Berechtigungen oder Seniorität.",
    en: "Guidance supplements the working approach. It does not change roles, personas, tools, permissions or seniority.",
  },
  "Guidance-Änderung vorschlagen": {
    de: "Guidance-Änderung vorschlagen",
    en: "Propose guidance change",
  },
  Titel: {
    de: "Titel",
    en: "Title",
  },
  "Vollständige neue Coaching-Guidance": {
    de: "Vollständige neue Coaching-Guidance",
    en: "Complete new coaching guidance",
  },
  "Aktive Version als Ausgangspunkt laden": {
    de: "Aktive Version als Ausgangspunkt laden",
    en: "Load active version as a starting point",
  },
  "Bereits installierte Skills": {
    de: "Bereits installierte Skills",
    en: "Already installed skills",
  },
  "Keine installierten Skills. Hier werden keine Pakete nachgeladen.": {
    de: "Keine installierten Skills. Hier werden keine Pakete nachgeladen.",
    en: "No installed skills. No packages are downloaded here.",
  },
  "Deterministische Prüfkriterien": {
    de: "Deterministische Prüfkriterien",
    en: "Deterministic evaluation criteria",
  },
  "Text- und Statusprüfungen sind messbare Bedingungen, keine Genauigkeitsnote. Bestehende Run-Nachweise belegen vergangene Arbeit, nicht die Wirksamkeit einer noch nicht eingesetzten Guidance.":
    {
      de: "Text- und Statusprüfungen sind messbare Bedingungen, keine Genauigkeitsnote. Bestehende Run-Nachweise belegen vergangene Arbeit, nicht die Wirksamkeit einer noch nicht eingesetzten Guidance.",
      en: "Text and status checks are measurable conditions, not accuracy scores. Existing run evidence documents past work, not the effectiveness of guidance that has not yet been used.",
    },
  Prüfung: {
    de: "Prüfung",
    en: "Check",
  },
  ": Bezeichnung": {
    de: ": Bezeichnung",
    en: ": Label",
  },
  ": Typ": {
    de: ": Typ",
    en: ": Type",
  },
  ": Erwarteter Text oder Skill": {
    de: ": Erwarteter Text oder Skill",
    en: ": Expected text or skill",
  },
  ": Run-ID": {
    de: ": Run-ID",
    en: ": Run ID",
  },
  entfernen: {
    de: "entfernen",
    en: "remove",
  },
  "Prüfung hinzufügen": {
    de: "Prüfung hinzufügen",
    en: "Add check",
  },
  "Vorschlag speichern": {
    de: "Vorschlag speichern",
    en: "Save proposal",
  },
  "Vorschläge und Ergebnisse": {
    de: "Vorschläge und Ergebnisse",
    en: "Proposals and results",
  },
  "Noch keine Vorschläge. Eine Beobachtung aus dem nächsten Review kann der Ausgangspunkt sein.": {
    de: "Noch keine Vorschläge. Eine Beobachtung aus dem nächsten Review kann der Ausgangspunkt sein.",
    en: "No proposals yet. An observation from the next review can be a starting point.",
  },
  Basisversion: {
    de: "Basisversion",
    en: "Base version",
  },
  "Änderung und Kriterien ansehen": {
    de: "Änderung und Kriterien ansehen",
    en: "View change and criteria",
  },
  von: {
    de: "von",
    en: "of",
  },
  "Kriterien bestanden": {
    de: "Kriterien bestanden",
    en: "criteria passed",
  },
  Bestanden: {
    de: "Bestanden",
    en: "Passed",
  },
  "Nicht bestanden": {
    de: "Nicht bestanden",
    en: "Failed",
  },
  "Gespeicherter Run-Nachweis": {
    de: "Gespeicherter Run-Nachweis",
    en: "Saved run evidence",
  },
  "Auswertung gespeichert. Alle Ergebnisse sind im Vorschlag sichtbar.": {
    de: "Auswertung gespeichert. Alle Ergebnisse sind im Vorschlag sichtbar.",
    en: "Evaluation saved. All results are visible in the proposal.",
  },
  "Kriterien auswerten": {
    de: "Kriterien auswerten",
    en: "Evaluate criteria",
  },
  "Begründung für „": {
    de: "Begründung für „",
    en: "Reason for “",
  },
  "Freigeben und übernehmen": {
    de: "Freigeben und übernehmen",
    en: "Approve and apply",
  },
  Ablehnen: {
    de: "Ablehnen",
    en: "Reject",
  },
  "Entscheidung von": {
    de: "Entscheidung von",
    en: "Decision by",
  },
  "1-on-1, Retrospektiven und Lessons Learned": {
    de: "1-on-1, Retrospektiven und Lessons Learned",
    en: "1-on-1s, retrospectives and lessons learned",
  },
  "Beobachtung gespeichert. Sie verändert die Guidance nicht automatisch.": {
    de: "Beobachtung gespeichert. Sie verändert die Guidance nicht automatisch.",
    en: "Observation saved. It does not change the guidance automatically.",
  },
  Art: {
    de: "Art",
    en: "Type",
  },
  "Titel der Beobachtung": {
    de: "Titel der Beobachtung",
    en: "Observation title",
  },
  "Beobachtung, Vereinbarungen und nächste Schritte": {
    de: "Beobachtung, Vereinbarungen und nächste Schritte",
    en: "Observation, agreements and next steps",
  },
  "Run-ID als Quelle (optional)": {
    de: "Run-ID als Quelle (optional)",
    en: "Source run ID (optional)",
  },
  "Beobachtung speichern": {
    de: "Beobachtung speichern",
    en: "Save observation",
  },
  "Noch keine Beobachtungen gespeichert.": {
    de: "Noch keine Beobachtungen gespeichert.",
    en: "No observations saved yet.",
  },
  "Versionsverlauf (": {
    de: "Versionsverlauf (",
    en: "Version history (",
  },
  "· Vorschlag": {
    de: "· Vorschlag",
    en: "· Proposal",
  },
  "Planung läuft": {
    de: "Planung läuft",
    en: "Planning in progress",
  },
  "CEO-Entscheidung offen": {
    de: "CEO-Entscheidung offen",
    en: "Awaiting CEO decision",
  },
  "Plan freigegeben": {
    de: "Plan freigegeben",
    en: "Plan approved",
  },
  "Plan abgelehnt": {
    de: "Plan abgelehnt",
    en: "Plan rejected",
  },
  "Plan nicht verwendbar": {
    de: "Plan nicht verwendbar",
    en: "Plan unusable",
  },
  Niedrig: {
    de: "Niedrig",
    en: "Low",
  },
  Mittel: {
    de: "Mittel",
    en: "Medium",
  },
  Hoch: {
    de: "Hoch",
    en: "High",
  },
  Kritisch: {
    de: "Kritisch",
    en: "Critical",
  },
  "Keine angegeben.": {
    de: "Keine angegeben.",
    en: "None specified.",
  },
  "Projektpläne konnten nicht geladen werden.": {
    de: "Projektpläne konnten nicht geladen werden.",
    en: "Project plans could not be loaded.",
  },
  "Plan freigegeben. Die genehmigten Aufgaben und Abhängigkeiten wurden angelegt.": {
    de: "Plan freigegeben. Die genehmigten Aufgaben und Abhängigkeiten wurden angelegt.",
    en: "Plan approved. The approved tasks and dependencies have been created.",
  },
  "Plan abgelehnt. Die geplanten Teilaufgaben werden nicht ausgeführt.": {
    de: "Plan abgelehnt. Die geplanten Teilaufgaben werden nicht ausgeführt.",
    en: "Plan rejected. The planned subtasks will not be executed.",
  },
  "Die Entscheidung konnte nicht gespeichert werden.": {
    de: "Die Entscheidung konnte nicht gespeichert werden.",
    en: "The decision could not be saved.",
  },
  Projektplanung: {
    de: "Projektplanung",
    en: "Project planning",
  },
  Projektpläne: {
    de: "Projektpläne",
    en: "Project plans",
  },
  "Ziel, Umfang und Aufgaben prüfen. Die Crew beginnt die geplante Projektarbeit nach deiner Freigabe.": {
    de: "Ziel, Umfang und Aufgaben prüfen. Die Crew beginnt die geplante Projektarbeit nach deiner Freigabe.",
    en: "Review the goal, scope and tasks. The crew starts the planned project work after your approval.",
  },
  "Projektpläne werden geladen …": {
    de: "Projektpläne werden geladen …",
    en: "Loading project plans …",
  },
  "Pläne aktualisieren": {
    de: "Pläne aktualisieren",
    en: "Refresh plans",
  },
  "Noch keine Projektpläne. Beschreibe im CEO-Chat ein Projekt; der Executive Assistant erstellt zuerst einen Plan zur Prüfung.":
    {
      de: "Noch keine Projektpläne. Beschreibe im CEO-Chat ein Projekt; der Executive Assistant erstellt zuerst einen Plan zur Prüfung.",
      en: "No project plans yet. Describe a project in CEO chat; the executive assistant first creates a plan for review.",
    },
  "Projekt wird vorbereitet": {
    de: "Projekt wird vorbereitet",
    en: "Preparing project",
  },
  "Quelle und Verlauf": {
    de: "Quelle und Verlauf",
    en: "Source and history",
  },
  "Projekt:": {
    de: "Projekt:",
    en: "Project:",
  },
  "Planungsaufgabe:": {
    de: "Planungsaufgabe:",
    en: "Planning task:",
  },
  "Planungs-Run:": {
    de: "Planungs-Run:",
    en: "Planning run:",
  },
  "Entschieden von:": {
    de: "Entschieden von:",
    en: "Decided by:",
  },
  "Planungsaufgabe öffnen": {
    de: "Planungsaufgabe öffnen",
    en: "Open planning task",
  },
  "Der Planungs-Run darf den Auftrag strukturieren. Noch keine geplanten Teilaufgaben freigegeben.": {
    de: "Der Planungs-Run darf den Auftrag strukturieren. Noch keine geplanten Teilaufgaben freigegeben.",
    en: "The planning run may structure the assignment. No planned subtasks have been approved yet.",
  },
  Umfang: {
    de: "Umfang",
    en: "Scope",
  },
  "Nicht-Ziele": {
    de: "Nicht-Ziele",
    en: "Out of scope",
  },
  Annahmen: {
    de: "Annahmen",
    en: "Assumptions",
  },
  Risiken: {
    de: "Risiken",
    en: "Risks",
  },
  "Geplantes Budget": {
    de: "Geplantes Budget",
    en: "Planned budget",
  },
  "0 USD angegeben – Annahmen und Freigabepunkte prüfen; kein Nachweis kostenloser Ausführung.": {
    de: "0 USD angegeben – Annahmen und Freigabepunkte prüfen; kein Nachweis kostenloser Ausführung.",
    en: "0 USD specified — review assumptions and approval points; this is not evidence of free execution.",
  },
  "Planwert, keine bereits angefallenen Kosten. Firmen-, Projekt- und Runtime-Limits gelten weiterhin.": {
    de: "Planwert, keine bereits angefallenen Kosten. Firmen-, Projekt- und Runtime-Limits gelten weiterhin.",
    en: "A planned amount, not costs already incurred. Company, project and runtime limits still apply.",
  },
  "Erwartete Ergebnisse": {
    de: "Erwartete Ergebnisse",
    en: "Expected deliverables",
  },
  Freigabepunkte: {
    de: "Freigabepunkte",
    en: "Approval points",
  },
  "Keine zusätzlichen Freigabepunkte angegeben. Die Sicherheitsrichtlinien gelten weiterhin.": {
    de: "Keine zusätzlichen Freigabepunkte angegeben. Die Sicherheitsrichtlinien gelten weiterhin.",
    en: "No additional approval points specified. Security policies still apply.",
  },
  "Aufgaben und Abhängigkeiten": {
    de: "Aufgaben und Abhängigkeiten",
    en: "Tasks and dependencies",
  },
  Aufgabenschlüssel: {
    de: "Aufgabenschlüssel",
    en: "Task key",
  },
  "Abhängig von": {
    de: "Abhängig von",
    en: "Depends on",
  },
  "Keine Abhängigkeit": {
    de: "Keine Abhängigkeit",
    en: "No dependencies",
  },
  Risiko: {
    de: "Risiko",
    en: "Risk",
  },
  Abnahmekriterien: {
    de: "Abnahmekriterien",
    en: "Acceptance criteria",
  },
  "Die Freigabe übernimmt diesen Plan in den Task-Baum. Risikoreiche Einzelaktionen benötigen weiterhin ihre eigenen Freigaben.":
    {
      de: "Die Freigabe übernimmt diesen Plan in den Task-Baum. Risikoreiche Einzelaktionen benötigen weiterhin ihre eigenen Freigaben.",
      en: "Approval adds this plan to the task tree. Individual high-risk actions still require their own approvals.",
    },
  "Plan freigeben": {
    de: "Plan freigeben",
    en: "Approve plan",
  },
  "Plan ablehnen": {
    de: "Plan ablehnen",
    en: "Reject plan",
  },
  "Die Entscheidung benötigt die Owner-Rolle.": {
    de: "Die Entscheidung benötigt die Owner-Rolle.",
    en: "The decision requires the owner role.",
  },
  "Sandbox-Zugriffe konnten nicht geladen werden.": {
    de: "Sandbox-Zugriffe konnten nicht geladen werden.",
    en: "Sandbox access could not be loaded.",
  },
  "Änderung fehlgeschlagen.": {
    de: "Änderung fehlgeschlagen.",
    en: "Change failed.",
  },
  "Sandbox-Ausnahmen": {
    de: "Sandbox-Ausnahmen",
    en: "Sandbox exceptions",
  },
  "CLI-Sicherheitsabfragen nur für eine konkrete Aufgabe, deren Projekt-Workspace und genau einen Run umgehen. Der Owner muss die Anfrage in der Freigabe-Inbox genehmigen.":
    {
      de: "CLI-Sicherheitsabfragen nur für eine konkrete Aufgabe, deren Projekt-Workspace und genau einen Run umgehen. Der Owner muss die Anfrage in der Freigabe-Inbox genehmigen.",
      en: "Bypass CLI security prompts only for a specific task, its project workspace and exactly one run. The owner must approve the request in the approvals inbox.",
    },
  "Ein Widerruf oder Ablauf beendet den erhöhten Run. Bereits erfolgte Änderungen bleiben bestehen und benötigen eine Prüfung.":
    {
      de: "Ein Widerruf oder Ablauf beendet den erhöhten Run. Bereits erfolgte Änderungen bleiben bestehen und benötigen eine Prüfung.",
      en: "Revocation or expiry terminates the elevated run. Changes already made remain and need review.",
    },
  "Anfrage erstellt. Bitte die konkrete Ausnahme in der Freigabe-Inbox prüfen.": {
    de: "Anfrage erstellt. Bitte die konkrete Ausnahme in der Freigabe-Inbox prüfen.",
    en: "Request created. Please review the specific exception in the approvals inbox.",
  },
  Aufgabe: {
    de: "Aufgabe",
    en: "Task",
  },
  "Aufgabe mit Projekt auswählen": {
    de: "Aufgabe mit Projekt auswählen",
    en: "Select a task with a project",
  },
  "Zeitfenster in Minuten": {
    de: "Zeitfenster in Minuten",
    en: "Time window in minutes",
  },
  Begründung: {
    de: "Begründung",
    en: "Reason",
  },
  "Ausnahme anfragen": {
    de: "Ausnahme anfragen",
    en: "Request exception",
  },
  "Offene Anfragen": {
    de: "Offene Anfragen",
    en: "Pending requests",
  },
  "Keine offenen Sandbox-Anfragen.": {
    de: "Keine offenen Sandbox-Anfragen.",
    en: "No pending sandbox requests.",
  },
  "Genehmigte Zeitfenster": {
    de: "Genehmigte Zeitfenster",
    en: "Approved time windows",
  },
  "Noch keine Sandbox-Ausnahme genehmigt.": {
    de: "Noch keine Sandbox-Ausnahme genehmigt.",
    en: "No sandbox exceptions approved yet.",
  },
  "An einen Run gebunden": {
    de: "An einen Run gebunden",
    en: "Bound to a run",
  },
  "Für einen Run verfügbar": {
    de: "Für einen Run verfügbar",
    en: "Available for one run",
  },
  "· endet": {
    de: "· endet",
    en: "· expires",
  },
  "Vom Owner in der Sandbox-Ansicht widerrufen": {
    de: "Vom Owner in der Sandbox-Ansicht widerrufen",
    en: "Revoked by the owner in the sandbox view",
  },
  "Sandbox-Ausnahme widerrufen.": {
    de: "Sandbox-Ausnahme widerrufen.",
    en: "Sandbox exception revoked.",
  },
  Widerrufen: {
    de: "Widerrufen",
    en: "Revoke",
  },
  Aktualisieren: {
    de: "Aktualisieren",
    en: "Refresh",
  },
  "Runner konnten nicht geladen werden": {
    de: "Runner konnten nicht geladen werden",
    en: "Runners could not be loaded",
  },
  "Runner-Änderung fehlgeschlagen": {
    de: "Runner-Änderung fehlgeschlagen",
    en: "Runner change failed",
  },
  "Native Runner-Flotte": {
    de: "Native Runner-Flotte",
    en: "Native runner fleet",
  },
  "Runner verbinden sich ausgehend per TLS. Projektordner und Runtime sind fest zugewiesen. CLI-Anmeldungen bleiben beim Runner-Benutzer.":
    {
      de: "Runner verbinden sich ausgehend per TLS. Projektordner und Runtime sind fest zugewiesen. CLI-Anmeldungen bleiben beim Runner-Benutzer.",
      en: "Runners connect outbound using TLS. Project folders and runtimes are fixed. CLI credentials stay with the runner user.",
    },
  "Runner-Name": {
    de: "Runner-Name",
    en: "Runner name",
  },
  "Workspace auf dem Runner": {
    de: "Workspace auf dem Runner",
    en: "Workspace on the runner",
  },
  Projekt: {
    de: "Projekt",
    en: "Project",
  },
  "Projekt auswählen": {
    de: "Projekt auswählen",
    en: "Select project",
  },
  "Parallele Runs": {
    de: "Parallele Runs",
    en: "Parallel runs",
  },
  "Einmalige Anmeldung erstellen": {
    de: "Einmalige Anmeldung erstellen",
    en: "Create one-time enrollment",
  },
  "Anmeldung für": {
    de: "Anmeldung für",
    en: "Enrollment for",
  },
  "Einmaliger Token, gültig bis": {
    de: "Einmaliger Token, gültig bis",
    en: "One-time token, valid until",
  },
  ". Im lokalen Runner-Setup verwenden. Er wird hier nur bis zum Schließen angezeigt.": {
    de: ". Im lokalen Runner-Setup verwenden. Er wird hier nur bis zum Schließen angezeigt.",
    en: ". Use it in local runner setup. It is displayed here only until you close it.",
  },
  "Token ausblenden": {
    de: "Token ausblenden",
    en: "Hide token",
  },
  "Letztes Signal:": {
    de: "Letztes Signal:",
    en: "Last heartbeat:",
  },
  "noch keines": {
    de: "noch keines",
    en: "none yet",
  },
  "Zugriff widerrufen": {
    de: "Zugriff widerrufen",
    en: "Revoke access",
  },
  "Noch kein Runner angemeldet.": {
    de: "Noch kein Runner angemeldet.",
    en: "No runners enrolled yet.",
  },
  "prüfe …": {
    de: "prüfe …",
    en: "checking …",
  },
  Ansehen: {
    de: "Ansehen",
    en: "View",
  },
  Installieren: {
    de: "Installieren",
    en: "Install",
  },
  "Abteilungen ·": {
    de: "Abteilungen ·",
    en: "Departments ·",
  },
  "Posten ·": {
    de: "Posten ·",
    en: "Positions ·",
  },
  "Werkzeuge ·": {
    de: "Werkzeuge ·",
    en: "Tools ·",
  },
  Routinen: {
    de: "Routinen",
    en: "Routines",
  },
  konfiguriert: {
    de: "konfiguriert",
    en: "configured",
  },
  "Verbindung prüfen": {
    de: "Verbindung prüfen",
    en: "Check connection",
  },
  "nicht konfiguriert —": {
    de: "nicht konfiguriert —",
    en: "not configured —",
  },
  "— was dazukommt": {
    de: "— was dazukommt",
    en: "— what will be added",
  },
  Posten: {
    de: "Posten",
    en: "Positions",
  },
  ", max. Risiko": {
    de: ", max. Risiko",
    en: ", max. risk",
  },
  Werkzeuge: {
    de: "Werkzeuge",
    en: "Tools",
  },
  "Routinen (werden ausgeschaltet installiert)": {
    de: "Routinen (werden ausgeschaltet installiert)",
    en: "Routines (installed disabled)",
  },
  "— alle": {
    de: "— alle",
    en: "— every",
  },
  "OpenRouter-Modelle werden geladen. Modell-ID ist frei eingebbar.": {
    de: "OpenRouter-Modelle werden geladen. Modell-ID ist frei eingebbar.",
    en: "Loading OpenRouter models. You can enter any model ID.",
  },
  "Katalog nicht erreichbar. Modell-ID direkt eingeben.": {
    de: "Katalog nicht erreichbar. Modell-ID direkt eingeben.",
    en: "Catalog unavailable. Enter the model ID directly.",
  },
  " Katalog vorübergehend veraltet.": {
    de: " Katalog vorübergehend veraltet.",
    en: " Catalog temporarily outdated.",
  },
  "Dieses Modell liefert keine Textausgabe; die Agenten-Runtime benötigt Text-Chat.": {
    de: "Dieses Modell liefert keine Textausgabe; die Agenten-Runtime benötigt Text-Chat.",
    en: "This model does not produce text output; the agent runtime requires text chat.",
  },
};

Object.assign(governanceMessages, {
  Ausgeschaltet: { de: "Ausgeschaltet", en: "Disabled" },
  ausgeschaltet: { de: "ausgeschaltet", en: "disabled" },
  verboten: { de: "verboten", en: "prohibited" },
  erlaubt: { de: "erlaubt", en: "allowed" },
  erforderlich: { de: "erforderlich", en: "required" },
  keine: { de: "keine", en: "none" },
  alle: { de: "alle", en: "all" },
  Modellfamilien: { de: "Modellfamilien", en: "Model families" },
  "OpenRouter-Provider": { de: "OpenRouter-Provider", en: "OpenRouter providers" },
  Erlaubt: { de: "Erlaubt", en: "Allowed" },
  Blockiert: { de: "Blockiert", en: "Blocked" },
  Abgelaufen: { de: "Abgelaufen", en: "Expired" },
});

export function useGovernanceI18n() {
  const { t, locale, language } = useI18n();
  const tx = useCallback(
    (message: string) => {
      const copy = governanceMessages[message];
      return copy ? t(copy) : message;
    },
    [t],
  );
  return { tx, t, locale, language };
}
