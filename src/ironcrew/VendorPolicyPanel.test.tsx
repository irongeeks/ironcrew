import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetApiRuntimeForTests, writeStoredCsrfToken } from "../api/core";
import type { CompanyPolicySnapshot, SaveCompanyPolicyInput } from "../shared/company-policy";
import { VendorPolicyPanel } from "./VendorPolicyPanel";

let server: CompanyPolicySnapshot;
let failure: { status: number; message: string } | null;
let readsFail: boolean;
let pendingSave: Promise<void> | null;
let writes: Array<{ url: string; body: Record<string, unknown>; headers: Headers; credentials?: RequestCredentials }>;
const fingerprint = "a".repeat(64);
const reply = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
async function ready(canManage = true) {
  const result = render(<VendorPolicyPanel canManage={canManage} />);
  await screen.findByRole("group", { name: "Modellfamilien" });
  return result;
}
function reason(value = "Datenschutz im Pilotbetrieb eingrenzen") {
  fireEvent.change(screen.getByLabelText("Begründung der Änderung"), { target: { value } });
}
function save() {
  fireEvent.click(screen.getByRole("button", { name: "Freigaben speichern" }));
}
beforeEach(() => {
  __resetApiRuntimeForTests();
  sessionStorage.clear();
  writeStoredCsrfToken("policy-csrf");
  failure = null;
  readsFail = false;
  pendingSave = null;
  writes = [];
  server = {
    revision: 2,
    baselineFingerprint: fingerprint,
    baseline: { allowedFamilies: ["openai/*", "anthropic/*"], allowedProviders: ["OpenAI", "Anthropic"] },
    restrictions: { allowedFamilies: ["openai/*", "anthropic/*"], allowedProviders: ["OpenAI", "Anthropic"] },
    effectivePolicy: {
      version: 1,
      policy_name: "Test-Policy",
      allowed_families: ["openai/*", "anthropic/*"],
      blocked_families: [{ id: "deepseek", reason: "Zentral ausgeschlossen", match: ["deepseek"] }],
      blocked_endpoints: [{ id: "wechat", reason: "Zentral ausgeschlossen", match: ["wechat"] }],
      openrouter: {
        allowed_providers: ["OpenAI", "Anthropic"],
        allow_fallbacks: false,
        sensitive_defaults: { data_collection: "deny", zdr: true, allow_fallbacks: false },
      },
      telemetry: { enabled: false },
    },
    history: [
      {
        revision: 2,
        createdAt: 1750000000000,
        createdBy: "owner-1",
        reason: "Freigaben für Pilotbetrieb vorbereitet",
        baselineFingerprint: fingerprint,
        restrictions: { allowedFamilies: ["openai/*", "anthropic/*"], allowedProviders: ["OpenAI", "Anthropic"] },
        correlationId: "correlation-2",
        auditEventId: "audit-2",
      },
    ],
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options?: RequestInit) => {
      if ((options?.method ?? "GET") === "GET" && url === "/api/crew/policies/vendor") {
        return readsFail
          ? reply({ error: "unavailable", message: "Policy-Server nicht erreichbar" }, 503)
          : reply(server);
      }
      const headers = new Headers(options?.headers);
      const body = JSON.parse(String(options?.body)) as Record<string, unknown>;
      writes.push({ url, body, headers, credentials: options?.credentials });
      if (headers.get("Content-Type") !== "application/json") return reply({ message: "JSON required" }, 415);
      if (failure) return reply({ error: "policy_rejected", message: failure.message }, failure.status);
      if (url === "/api/crew/policies/vendor/check") {
        const allowed = body.model !== "deepseek/model";
        return reply({
          model: body.model,
          provider: body.provider ?? null,
          decision: {
            allowed,
            code: allowed ? "allowed" : "blocked_family",
            reason: allowed ? "Zentral und für Firma freigegeben" : "Zentral gesperrte Modellfamilie",
          },
          revision: server.revision,
          baselineFingerprint: server.baselineFingerprint,
        });
      }
      if (url === "/api/crew/policies/vendor" && options?.method === "PUT") {
        if (pendingSave) await pendingSave;
        const input = body as unknown as SaveCompanyPolicyInput;
        if (input.baseRevision !== server.revision || input.baselineFingerprint !== server.baselineFingerprint)
          return reply({ error: "revision_conflict" }, 409);
        server = {
          ...server,
          revision: server.revision + 1,
          restrictions: input.restrictions,
          effectivePolicy: {
            ...server.effectivePolicy,
            allowed_families: input.restrictions.allowedFamilies,
            openrouter: {
              ...server.effectivePolicy.openrouter,
              allowed_providers: input.restrictions.allowedProviders,
            },
          },
        };
        return reply(server);
      }
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("VendorPolicyPanel", () => {
  it("shows immutable baseline and saves only explicit restrictions with reason, version and CSRF", async () => {
    await ready();
    const baseline = screen.getByRole("region", { name: "Zentrale Schutzregeln" });
    expect(within(baseline).queryByRole("checkbox")).not.toBeInTheDocument();
    expect(within(baseline).getByText("deepseek")).toBeInTheDocument();
    expect(screen.getAllByRole("checkbox")).toHaveLength(4);
    fireEvent.click(screen.getByLabelText("anthropic/*"));
    fireEvent.click(screen.getByLabelText("Anthropic", { exact: true }));
    reason("kurz");
    expect(screen.getByRole("button", { name: "Freigaben speichern" })).toBeDisabled();
    reason();
    save();
    await screen.findByText(/Freigaben gespeichert. Revision 3/);
    expect(writes).toHaveLength(1);
    expect(writes[0].body).toEqual({
      baseRevision: 2,
      baselineFingerprint: fingerprint,
      reason: "Datenschutz im Pilotbetrieb eingrenzen",
      restrictions: { allowedFamilies: ["openai/*"], allowedProviders: ["OpenAI"] },
    });
    expect(writes[0].headers.get("x-csrf-token")).toBe("policy-csrf");
    expect(writes[0].headers.get("Content-Type")).toBe("application/json");
    expect(writes[0].credentials).toBe("same-origin");
    expect(screen.getByRole("button", { name: "Freigaben speichern" })).toBeDisabled();
  });
  it("saves empty selections as explicit deny-all rather than restoring defaults", async () => {
    await ready();
    for (const checkbox of screen.getAllByRole("checkbox")) fireEvent.click(checkbox);
    expect(screen.getByText(/Alle Modellanfragen werden blockiert/)).toBeVisible();
    expect(screen.getByText(/OpenRouter-Anfragen werden blockiert/)).toBeVisible();
    reason("Alle externen Modelle vorübergehend pausieren");
    save();
    await screen.findByText(/Freigaben gespeichert/);
    expect(writes[0].body.restrictions).toEqual({ allowedFamilies: [], allowedProviders: [] });
  });
  it("retains draft and reason through conflict reload and requires deliberate rebase before saving", async () => {
    await ready();
    fireEvent.click(screen.getByLabelText("anthropic/*"));
    reason();
    server.revision = 3;
    save();
    await screen.findByText(/Dein Entwurf bleibt erhalten/);
    expect(screen.getByRole("button", { name: "Freigaben speichern" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Serverstand laden" }));
    await screen.findByText(/Der Entwurf basiert auf Revision 2/);
    expect(screen.getByLabelText("anthropic/*")).not.toBeChecked();
    expect(screen.getByLabelText("Begründung der Änderung")).toHaveValue("Datenschutz im Pilotbetrieb eingrenzen");
    expect(screen.getByRole("button", { name: "Freigaben speichern" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Entwurf auf geladenem Stand weiterbearbeiten" }));
    save();
    await screen.findByText(/Freigaben gespeichert. Revision 4/);
    expect(writes[1].body.baseRevision).toBe(3);
    expect((writes[1].body.restrictions as SaveCompanyPolicyInput["restrictions"]).allowedFamilies).toEqual([
      "openai/*",
    ]);
  });
  it("preserves edits when live updates change baseline and prevents saving removed selections", async () => {
    const view = await ready();
    reason();
    server.baselineFingerprint = "b".repeat(64);
    server.baseline.allowedProviders = ["OpenAI"];
    view.rerender(<VendorPolicyPanel canManage refreshKey={1} />);
    await screen.findByText(/Entferne die Auswahlen/);
    expect(screen.getByLabelText(/Anthropic — zentral nicht mehr erlaubt/)).toBeChecked();
    expect(screen.getByRole("button", { name: "Freigaben speichern" })).toBeDisabled();
    fireEvent.click(screen.getByLabelText(/Anthropic — zentral nicht mehr erlaubt/));
    fireEvent.click(screen.getByRole("button", { name: "Entwurf auf geladenem Stand weiterbearbeiten" }));
    save();
    await screen.findByText(/Freigaben gespeichert/);
    expect(writes[0].body.baselineFingerprint).toBe("b".repeat(64));
  });
  it("defaults to read-only while allowing a persisted policy check", async () => {
    render(<VendorPolicyPanel />);
    await screen.findByLabelText("openai/*");
    for (const checkbox of screen.getAllByRole("checkbox")) expect(checkbox).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Freigaben speichern" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Modell-ID"), { target: { value: "openai/model" } });
    fireEvent.change(screen.getByLabelText("Provider (optional)"), { target: { value: "OpenAI" } });
    fireEvent.click(screen.getByRole("button", { name: "Gespeicherte Policy prüfen" }));
    await screen.findByText(/Erlaubt: openai\/model/);
    expect(writes[0].body).toEqual({ model: "openai/model", provider: "OpenAI" });
    expect(writes[0].url).toBe("/api/crew/policies/vendor/check");
  });
  it("separates model policy denial from authentication failure and clears outdated results on input changes", async () => {
    await ready(false);
    fireEvent.change(screen.getByLabelText("Modell-ID"), { target: { value: "deepseek/model" } });
    fireEvent.click(screen.getByRole("button", { name: "Gespeicherte Policy prüfen" }));
    await screen.findByText(/Blockiert: deepseek\/model/);
    expect(screen.getByText(/geprüfte Revision 2/)).toBeVisible();
    fireEvent.change(screen.getByLabelText("Modell-ID"), { target: { value: "openai/model" } });
    expect(screen.queryByText(/Blockiert: deepseek\/model/)).not.toBeInTheDocument();
    failure = { status: 403, message: "Zugriff verweigert" };
    fireEvent.click(screen.getByRole("button", { name: "Gespeicherte Policy prüfen" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("alert")).toHaveTextContent("Zugriff verweigert");
    expect(screen.queryByText(/Erlaubt:/)).not.toBeInTheDocument();
  });
  it("recovers an initial loading failure and shows persisted audit provenance", async () => {
    readsFail = true;
    render(<VendorPolicyPanel canManage />);
    await screen.findByText("Policy-Server nicht erreichbar");
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    readsFail = false;
    fireEvent.click(screen.getByRole("button", { name: "Serverstand laden" }));
    await screen.findByLabelText("openai/*");
    fireEvent.click(screen.getByText("Änderungsverlauf (1)"));
    expect(screen.getByText("Freigaben für Pilotbetrieb vorbereitet")).toBeVisible();
    expect(screen.getByText(/Audit: audit-2 · Korrelation: correlation-2/)).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it("keeps a rejected editable draft and prevents duplicate saves while pending", async () => {
    await ready();
    fireEvent.click(screen.getByLabelText("anthropic/*"));
    reason();
    failure = { status: 400, message: "Freigabe durch zentrale Policy abgelehnt" };
    save();
    await screen.findByText("Freigabe durch zentrale Policy abgelehnt");
    expect(screen.getByLabelText("anthropic/*")).not.toBeChecked();
    failure = null;
    let resolve!: () => void;
    pendingSave = new Promise<void>((done) => {
      resolve = done;
    });
    save();
    expect(screen.getByRole("button", { name: "Freigaben werden gespeichert …" })).toBeDisabled();
    expect(screen.getByLabelText("openai/*")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Freigaben werden gespeichert …" }));
    await waitFor(() => expect(writes).toHaveLength(2));
    resolve();
    await screen.findByText(/Freigaben gespeichert/);
    expect(writes).toHaveLength(2);
  });
});
