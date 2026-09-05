import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetApiRuntimeForTests, writeStoredCsrfToken } from "../api/core";
import { ROUTING_PROFILE_KEYS, type RoutingConfig, type RoutingSnapshot } from "../shared/routing-profiles";
import { RoutingProfilesPanel } from "./RoutingProfilesPanel";

const agents = [{ id: "agent-1", displayName: "Ada" }];
let server: RoutingSnapshot;
let failure: { status: number; message: string } | null;
let writes: Array<{ url: string; body: unknown; headers: Headers; credentials?: RequestCredentials }>;
function reply(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}
function select(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label, { exact: true }), { target: { value } });
}
async function ready(canManage = true) {
  const result = render(<RoutingProfilesPanel agents={agents} canManage={canManage} />);
  await screen.findByLabelText("Profilbezeichnung");
  return result;
}
function save() {
  fireEvent.click(screen.getByRole("button", { name: "Alle Routing-Profile speichern" }));
}
beforeEach(() => {
  __resetApiRuntimeForTests();
  sessionStorage.clear();
  writeStoredCsrfToken("routing-csrf");
  failure = null;
  writes = [];
  server = {
    revision: 7,
    config: {
      version: 1,
      profiles: ROUTING_PROFILE_KEYS.map((key) => ({
        key,
        label: key,
        primary: null,
        fallbacks: [],
        allowFallback: false,
        allowedSensitivity: ["internal"],
        requiredCapabilities: [],
      })),
    },
    bindings: [{ agentId: "agent-1", profileKey: "coding" }],
    vessels: [
      { id: "codex-local", key: "codex", label: "Codex lokal", runtime_provider: "codex", model: "coding-alias" },
      { id: "claude-local", key: "claude", label: "Claude lokal", runtime_provider: "claude", model: "sonnet" },
      {
        id: "router",
        key: "router",
        label: "OpenRouter",
        runtime_provider: "openrouter",
        model: "google/research-model",
      },
    ],
    history: [{ revision: 7, createdAt: 1750000000000, createdBy: "owner" }],
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options?: RequestInit) => {
      if ((options?.method ?? "GET") === "GET" && url === "/api/crew/routing") return reply(server);
      const headers = new Headers(options?.headers);
      const body: unknown = JSON.parse(String(options?.body));
      writes.push({ url, body, headers, credentials: options?.credentials });
      // A real JSON transport is required: no mocking api/core or bypassing its CSRF path.
      if (headers.get("Content-Type") !== "application/json") return reply({ error: "JSON required" }, 415);
      if (failure) return reply({ error: "routing_rejected", message: failure.message }, failure.status);
      if (url === "/api/crew/routing") {
        const input = body as { expectedRevision: number; config: RoutingConfig };
        if (input.expectedRevision !== server.revision) return reply({ error: "revision_conflict" }, 409);
        server = { ...server, revision: server.revision + 1, config: input.config };
        return reply(server);
      }
      if (url === "/api/crew/routing/agents/agent-1") {
        const { profileKey } = body as { profileKey: string | null };
        server.bindings = profileKey ? [{ agentId: "agent-1", profileKey }] : [];
        return reply({ ok: true });
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

describe("RoutingProfilesPanel", () => {
  it("sends the exact versioned config and ordered explicit targets through JSON/CSRF transport", async () => {
    const original = structuredClone(server.config);
    await ready();
    select("Primärziel: Vessel", "codex-local");
    select("Primärziel: Modell", "new-coding-alias");
    expect(screen.getByLabelText("Primärziel: Vendor-Modell")).toHaveValue("openai/new-coding-alias");
    fireEvent.click(screen.getByRole("button", { name: "Fallback hinzufügen" }));
    select("Fallback 1: Vessel", "claude-local");
    fireEvent.click(screen.getByRole("button", { name: "Fallback hinzufügen" }));
    select("Fallback 2: Vessel", "router");
    fireEvent.click(screen.getByRole("button", { name: "Fallback 2 nach oben" }));
    fireEvent.click(screen.getByLabelText("Automatischen Fallback ausdrücklich erlauben"));
    fireEvent.click(screen.getByLabelText("Vertraulich", { exact: true }));
    fireEvent.click(screen.getByLabelText("Werkzeugaufrufe", { exact: true }));
    save();
    await screen.findByText(/Routing-Profile gespeichert/);
    const expected = structuredClone(original);
    const coding = expected.profiles.find((profile) => profile.key === "coding")!;
    Object.assign(coding, {
      primary: {
        vesselId: "codex-local",
        runtimeType: "codex",
        model: "new-coding-alias",
        vendorModel: "openai/new-coding-alias",
      },
      fallbacks: [
        {
          vesselId: "router",
          runtimeType: "openrouter",
          model: "google/research-model",
          vendorModel: "google/research-model",
        },
        { vesselId: "claude-local", runtimeType: "claude", model: "sonnet", vendorModel: "anthropic/sonnet" },
      ],
      allowFallback: true,
      allowedSensitivity: ["internal", "confidential"],
      requiredCapabilities: ["toolCalls"],
    });
    expect(writes).toHaveLength(1);
    expect(writes[0].body).toEqual({ expectedRevision: 7, config: expected });
    expect(writes[0].headers.get("Content-Type")).toBe("application/json");
    expect(writes[0].headers.get("x-csrf-token")).toBe("routing-csrf");
    expect(writes[0].credentials).toBe("same-origin");
  });

  it("clears an agent binding without changing the profile config", async () => {
    await ready();
    select("Routingprofil für Ada", "");
    fireEvent.click(screen.getByRole("button", { name: "Zuordnung für Ada speichern" }));
    await screen.findByText(/Profilzuordnung entfernt/);
    expect(writes).toHaveLength(1);
    expect(writes[0].url).toBe("/api/crew/routing/agents/agent-1");
    expect(writes[0].body).toEqual({ profileKey: null });
    expect(writes[0].headers.get("Content-Type")).toBe("application/json");
    expect(writes[0].headers.get("x-csrf-token")).toBe("routing-csrf");
    await waitFor(() => expect(screen.getByLabelText("Routingprofil für Ada")).toHaveValue(""));
  });

  it("preserves a rejected draft and requires explicit reload after a revision conflict", async () => {
    await ready();
    select("Profilbezeichnung", "Lokaler Entwurf");
    failure = { status: 409, message: "revision conflict" };
    save();
    await screen.findByText(/Dein Entwurf bleibt erhalten/);
    expect(screen.getByLabelText("Profilbezeichnung")).toHaveValue("Lokaler Entwurf");
    expect(screen.getByRole("button", { name: "Alle Routing-Profile speichern" })).toBeDisabled();
    failure = null;
    server.revision = 9;
    server.config.profiles.find((profile) => profile.key === "coding")!.label = "Serverprofil";
    fireEvent.click(screen.getByRole("button", { name: "Serverstand laden und Entwurf verwerfen" }));
    await waitFor(() => expect(screen.getByLabelText("Profilbezeichnung")).toHaveValue("Serverprofil"));
    expect(screen.getByText("Revision 9")).toBeVisible();
    expect(writes).toHaveLength(1);
  });

  it("keeps unsaved edits when a live refresh finds a newer revision", async () => {
    const result = await ready();
    select("Profilbezeichnung", "Lokales Coding");
    server.revision = 8;
    result.rerender(<RoutingProfilesPanel agents={agents} canManage refreshKey={1} />);
    await screen.findByText(/Auf dem Server liegt Revision 8/);
    expect(screen.getByLabelText("Profilbezeichnung")).toHaveValue("Lokales Coding");
    expect(screen.getByRole("button", { name: "Alle Routing-Profile speichern" })).toBeDisabled();
    expect(writes).toHaveLength(0);
  });

  it("shows policy rejections and preserves the editable target", async () => {
    await ready();
    select("Primärziel: Vessel", "codex-local");
    failure = { status: 400, message: "Vendor-Modell ist für dieses Ziel nicht erlaubt." };
    save();
    await screen.findByText("Vendor-Modell ist für dieses Ziel nicht erlaubt.");
    expect(screen.getByLabelText("Primärziel: Vessel")).toHaveValue("codex-local");
    expect(screen.getByRole("button", { name: "Alle Routing-Profile speichern" })).toBeEnabled();
  });

  it("disables incomplete targets and clears all fallback routing when removing the primary", async () => {
    await ready();
    select("Primärziel: Vessel", "codex-local");
    fireEvent.click(screen.getByRole("button", { name: "Fallback hinzufügen" }));
    expect(screen.getByRole("button", { name: "Alle Routing-Profile speichern" })).toBeDisabled();
    select("Fallback 1: Vessel", "claude-local");
    fireEvent.click(screen.getByLabelText("Automatischen Fallback ausdrücklich erlauben"));
    select("Primärziel: Vessel", "");
    expect(screen.queryByLabelText("Fallback 1: Vessel")).not.toBeInTheDocument();
    save();
    await screen.findByText(/Routing-Profile gespeichert/);
    const body = writes[0].body as { config: RoutingConfig };
    expect(body.config.profiles.find((profile) => profile.key === "coding")).toMatchObject({
      primary: null,
      fallbacks: [],
      allowFallback: false,
    });
  });

  it("defaults to read-only while retaining profile navigation", async () => {
    render(<RoutingProfilesPanel agents={agents} />);
    await screen.findByLabelText("Profilbezeichnung");
    expect(screen.getByLabelText("Profilbezeichnung")).toBeDisabled();
    expect(screen.getByLabelText("Primärziel: Vessel")).toBeDisabled();
    expect(screen.getByLabelText("Routingprofil für Ada")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Alle Routing-Profile speichern" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Zuordnung für Ada speichern" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "research" }));
    expect(screen.getByLabelText("Profilbezeichnung")).toHaveValue("research");
    expect(writes).toHaveLength(0);
  });
});
