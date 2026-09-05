import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetApiRuntimeForTests, writeStoredCsrfToken } from "../api/core";
import {
  DEFAULT_COMPANY_CONFIGURATION,
  type CompanyConfigurationSnapshot,
  type SaveCompanyConfigurationInput,
} from "../shared/company-configuration";
import { ConfigurationPanel } from "./ConfigurationPanel";

const endpoint = "/api/crew/configuration";
let server: CompanyConfigurationSnapshot;
let failedRead: number | null;
let failedSave: number | null;
let pendingSave: Promise<void> | null;
let writes: Array<{ body: SaveCompanyConfigurationInput; headers: Headers; credentials?: RequestCredentials }>;
const reply = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
async function ready(canManage = true) {
  const result = render(<ConfigurationPanel canManage={canManage} />);
  await screen.findByRole("group", { name: "Laufzeiten bearbeiten" });
  return result;
}
function changeRuntime(value = "3") {
  fireEvent.change(screen.getByLabelText("Maximale parallele Runs"), { target: { value } });
}
function addReason(value = "Arbeitslast im Pilotbetrieb begrenzen") {
  fireEvent.change(screen.getByLabelText("Begründung der Änderung"), { target: { value } });
}
function save() {
  fireEvent.click(screen.getByRole("button", { name: "Konfiguration speichern" }));
}
beforeEach(() => {
  __resetApiRuntimeForTests();
  sessionStorage.clear();
  writeStoredCsrfToken("config-csrf");
  failedRead = null;
  failedSave = null;
  pendingSave = null;
  writes = [];
  server = {
    revision: 0,
    configuration: structuredClone(DEFAULT_COMPANY_CONFIGURATION),
    history: [],
    canEdit: true,
    constraints: { alwaysApprovalRequired: ["bank_transfer", "production_deployment"] },
    toolChoices: [
      { key: "web.search", label: "Websuche", riskClass: "read" },
      { key: "workspace.write", label: "Datei schreiben", riskClass: "write" },
    ],
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options?: RequestInit) => {
      if (url !== endpoint) throw new Error(`Unexpected request ${url}`);
      if ((options?.method ?? "GET") === "GET")
        return failedRead ? reply({ message: "Konfiguration nicht erreichbar" }, failedRead) : reply(server);
      const body = JSON.parse(String(options?.body)) as SaveCompanyConfigurationInput;
      writes.push({ body, headers: new Headers(options?.headers), credentials: options?.credentials });
      if (pendingSave) await pendingSave;
      if (failedSave) return reply({ message: "Änderung abgelehnt" }, failedSave);
      if (body.baseRevision !== server.revision) return reply({ message: "Konflikt" }, 409);
      server = {
        ...server,
        revision: server.revision + 1,
        configuration: body.configuration,
        history: [
          {
            revision: server.revision + 1,
            configuration: body.configuration,
            reason: body.reason,
            createdBy: "owner-1",
            createdAt: 1750000000000,
            correlationId: "correlation-1",
            auditEventId: "audit-1",
          },
          ...server.history,
        ],
      };
      return reply(server);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ConfigurationPanel", () => {
  it("saves runtime limits with revision, reason and shared CSRF transport and shows history", async () => {
    await ready();
    changeRuntime();
    addReason("kurz");
    expect(screen.getByRole("button", { name: "Konfiguration speichern" })).toBeDisabled();
    addReason();
    fireEvent.change(screen.getByLabelText("Maximale Laufzeit (Sekunden)"), { target: { value: "90" } });
    save();
    await screen.findByText("Konfiguration gespeichert. Revision 1 ist aktiv.");
    expect(writes).toHaveLength(1);
    expect(writes[0].body).toEqual({
      baseRevision: 0,
      reason: "Arbeitslast im Pilotbetrieb begrenzen",
      configuration: { ...DEFAULT_COMPANY_CONFIGURATION, runtime: { maxConcurrentRuns: 3, maxRunTimeoutMs: 90000 } },
    });
    expect(writes[0].headers.get("Content-Type")).toBe("application/json");
    expect(writes[0].headers.get("x-csrf-token")).toBe("config-csrf");
    expect(writes[0].credentials).toBe("same-origin");
    fireEvent.click(screen.getByText("Änderungsverlauf (1)"));
    expect(screen.getByText("Arbeitslast im Pilotbetrieb begrenzen")).toBeVisible();
    expect(screen.getByText("owner-1")).toBeVisible();
  });
  it("requires both confirmed owner permission and server edit permission", async () => {
    const result = await ready(false);
    expect(screen.getByLabelText("Maximale parallele Runs")).toBeDisabled();
    result.unmount();
    server.canEdit = false;
    await ready(true);
    expect(screen.getByLabelText("Maximale parallele Runs")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Konfiguration speichern" })).toBeDisabled();
    expect(writes).toHaveLength(0);
  });
  it("does not infer bootstrap authorization from a failed load", async () => {
    failedRead = 401;
    render(<ConfigurationPanel canManage />);
    await screen.findByRole("alert");
    expect(screen.queryByLabelText("Maximale parallele Runs")).not.toBeInTheDocument();
    failedRead = null;
    fireEvent.click(screen.getByRole("button", { name: "Serverstand laden" }));
    await screen.findByLabelText("Maximale parallele Runs");
    expect(writes).toHaveLength(0);
  });
  it("preserves drafts and reason on conflicts, requires explicit rebase and then saves current version", async () => {
    await ready();
    changeRuntime("4");
    addReason();
    server.revision = 2;
    save();
    await screen.findByText(/Der Serverstand wurde geändert/);
    expect(screen.getByLabelText("Maximale parallele Runs")).toHaveValue(4);
    expect(screen.getByRole("button", { name: "Konfiguration speichern" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Serverstand laden" }));
    await screen.findByText(/geladen ist Revision 2/);
    expect(screen.getByLabelText("Maximale parallele Runs")).toHaveValue(4);
    expect(screen.getByLabelText("Begründung der Änderung")).toHaveValue("Arbeitslast im Pilotbetrieb begrenzen");
    fireEvent.click(screen.getByRole("button", { name: "Entwurf auf geladenem Stand weiterbearbeiten" }));
    save();
    await screen.findByText("Konfiguration gespeichert. Revision 3 ist aktiv.");
    expect(writes[1].body.baseRevision).toBe(2);
  });
  it("retains dirty drafts on external live refresh without silently rebasing", async () => {
    const view = await ready();
    changeRuntime("2");
    addReason();
    server.revision = 4;
    view.rerender(<ConfigurationPanel canManage refreshKey={1} />);
    await screen.findByText(/geladen ist Revision 4/);
    expect(screen.getByLabelText("Maximale parallele Runs")).toHaveValue(2);
    fireEvent.click(screen.getByRole("button", { name: "Entwurf verwerfen" }));
    expect(screen.getByLabelText("Maximale parallele Runs")).toHaveValue(64);
    expect(screen.getByLabelText("Begründung der Änderung")).toHaveValue("");
  });
  it("keeps mandatory approvals immutable while adding approval requirements for registered tools", async () => {
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Freigaben" }));
    fireEvent.click(screen.getByText("Immer freigabepflichtig (2)"));
    expect(screen.getByText("bank_transfer")).toBeVisible();
    expect(screen.queryByRole("checkbox", { name: "bank_transfer" })).not.toBeInTheDocument();
    fireEvent.click(
      within(screen.getByRole("group", { name: "Zusätzlich freigabepflichtige Aktionen" })).getByRole("checkbox", {
        name: /Websuche/,
      }),
    );
    addReason();
    save();
    await screen.findByText("Konfiguration gespeichert. Revision 1 ist aktiv.");
    expect(writes[0].body.configuration.approvals.additionalRequiredTypes).toEqual(["web.search"]);
  });
  it("saves tool denials and risk gates together with memory controls without losing tab drafts", async () => {
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Tools" }));
    fireEvent.click(
      within(screen.getByRole("group", { name: "Tools sperren" })).getByRole("checkbox", { name: /Datei schreiben/ }),
    );
    fireEvent.click(screen.getByLabelText("Freigabe für Externe Aktion"));
    fireEvent.click(screen.getByRole("button", { name: "Memory" }));
    fireEvent.click(screen.getByLabelText("Memory-Kontext für Runs verwenden"));
    fireEvent.click(screen.getByLabelText("Optionale semantische Suche verwenden"));
    fireEvent.change(screen.getByLabelText("Maximale Kontext-Einträge"), { target: { value: "12" } });
    addReason();
    save();
    await screen.findByText("Konfiguration gespeichert. Revision 1 ist aktiv.");
    expect(writes[0].body.configuration.tools).toEqual({
      blockedToolKeys: ["workspace.write"],
      requireApprovalForRiskClasses: ["external"],
    });
    expect(writes[0].body.configuration.memory).toEqual({
      runContextEnabled: false,
      semanticSearchEnabled: false,
      maxContextEntries: 12,
    });
  });
  it("rejects invalid numeric drafts and preserves them after server errors", async () => {
    await ready();
    changeRuntime("0");
    addReason();
    expect(screen.getByRole("button", { name: "Konfiguration speichern" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("Prüfe die Eingaben");
    changeRuntime("3");
    failedSave = 403;
    save();
    await screen.findByText("Änderung abgelehnt");
    expect(screen.getByLabelText("Maximale parallele Runs")).toHaveValue(3);
    expect(screen.getByLabelText("Begründung der Änderung")).toHaveValue("Arbeitslast im Pilotbetrieb begrenzen");
  });
  it("prevents repeated writes and edits while saving", async () => {
    let resolve!: () => void;
    pendingSave = new Promise<void>((done) => {
      resolve = done;
    });
    await ready();
    changeRuntime();
    addReason();
    save();
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(screen.getByLabelText("Maximale parallele Runs")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Wird gespeichert …" })).toBeDisabled();
    resolve();
    await screen.findByText("Konfiguration gespeichert. Revision 1 ist aktiv.");
    expect(writes).toHaveLength(1);
  });
});
