import { describe, it, expect } from "vitest";
import {
  AUTONOMOUS_CATEGORIES,
  mayDelegateAutonomously,
  suggestDepartment,
  triage,
  TRIAGE_CATEGORIES,
} from "./triage.ts";

describe("classification", () => {
  it.each([
    ["Was kostet unsere Cloud-Infrastruktur aktuell?", "question"],
    ["Erstelle eine Übersicht unserer offenen Tickets.", "simple_task"],
    ["Wie ist der Status des Kundenprojekts?", "status_request"],
    ["Wir haben einen Ausfall im Rechenzentrum!", "incident"],
    ["Bitte überweise 4.500 EUR an den Lieferanten.", "sensitive_request"],
    ["Ändere die Priorität auf hoch und pausiere den Rest.", "change_request"],
    ["Genehmigt", "approval_response"],
  ])("classifies %j as %s", (message, expected) => {
    expect(triage(message).category).toBe(expected);
  });

  it("only ever returns a declared category", () => {
    for (const msg of ["hallo", "?", "x".repeat(400), "Überweisung an DE12 3456"]) {
      expect(TRIAGE_CATEGORIES).toContain(triage(msg).category);
    }
  });

  it("treats an outage as an incident even when phrased as a question", () => {
    const r = triage("Warum ist der Mailserver offline?");
    expect(r.category).toBe("incident");
    expect(r.riskLevel).toBe("high");
  });

  it("treats a payment request as sensitive even when phrased casually", () => {
    const r = triage("kannst du kurz die Rechnung per Überweisung bezahlen");
    expect(r.sensitive).toBe(true);
    expect(r.category).toBe("sensitive_request");
  });

  it("flags credential requests as sensitive", () => {
    expect(triage("Schick mir bitte den API-Key für OpenRouter.").sensitive).toBe(true);
  });

  it("does not let a question mark outrank a clear instruction", () => {
    expect(triage("Kannst du bitte die Dokumentation schreiben?").category).toBe("simple_task");
  });

  it("recognises a multi-step project", () => {
    const r = triage("Wir starten ein Projekt zur Migration der Kundendaten und danach den Rollout.");
    expect(r.category).toBe("project");
    expect(r.riskLevel).toBe("medium");
  });
});

describe("clarification", () => {
  it("asks when the message carries no signal at all", () => {
    expect(triage("hm").needsClarification).toBe(true);
    expect(triage("").needsClarification).toBe(true);
  });

  it("never stalls an incident behind a clarifying question", () => {
    expect(triage("Ausfall").needsClarification).toBe(false);
  });

  it("never stalls a sensitive request behind a clarifying question", () => {
    expect(triage("Überweisung").needsClarification).toBe(false);
  });

  it("does not ask when the signal is strong", () => {
    expect(triage("Bitte analysiere die Logdateien und dokumentiere die Ursache.").needsClarification).toBe(false);
  });
});

describe("department routing", () => {
  it.each([
    ["Prüfe die Firewall auf Schwachstellen", "security"],
    ["Die Rechnung von Lexware ist offen", "finance"],
    ["Der Vertrag enthält eine kritische Klausel", "legal"],
    ["Proxmox-Cluster braucht ein Backup", "infrastructure"],
    ["Mach eine Marktanalyse", "research"],
    ["Das UI-Layout ist inkonsistent", "design"],
    ["Wir brauchen eine SEO-Kampagne", "marketing"],
    ["Erstelle ein Angebot für den Lead", "sales"],
    ["Schreibe eine SOP für das Onboarding", "knowledge"],
    ["Baue eine MCP-Integration", "automation"],
    ["Finde den Bug in der Regression", "quality"],
    ["Refactor der API-Architektur", "engineering"],
  ])("routes %j to %s", (message, dept) => {
    expect(suggestDepartment(message)).toBe(dept);
  });

  it("returns undefined when nothing matches", () => {
    expect(suggestDepartment("hallo zusammen")).toBeUndefined();
  });
});

describe("autonomy", () => {
  it("permits autonomous delegation only for routine categories", () => {
    for (const c of AUTONOMOUS_CATEGORIES) {
      expect(["question", "simple_task", "status_request"]).toContain(c);
    }
  });

  it("never delegates a sensitive request autonomously", () => {
    expect(mayDelegateAutonomously(triage("Bitte überweise 100 EUR"))).toBe(false);
  });

  it("never delegates autonomously when clarification is needed", () => {
    expect(mayDelegateAutonomously(triage("hm"))).toBe(false);
  });

  it("delegates a routine task autonomously", () => {
    expect(mayDelegateAutonomously(triage("Erstelle bitte die Dokumentation zum Deployment."))).toBe(true);
  });

  it("does not delegate an incident autonomously", () => {
    expect(mayDelegateAutonomously(triage("Ausfall im Rechenzentrum"))).toBe(false);
  });
});
