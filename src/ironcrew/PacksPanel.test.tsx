/**
 * The panel exists to tell the truth about integrations.
 *
 * Everything else it does — install, remove, show a definition — is ordinary.
 * The part worth locking down is that "nicht konfiguriert" is rendered from
 * the server's answer and names the variables that would change it, because
 * that is the difference between a feature flag and a fake button.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PacksPanel } from "./PacksPanel";
import type { BusinessPackSummary } from "./types";

const PACK: BusinessPackSummary = {
  key: "msp",
  label: "MSP / IT-Betrieb",
  summary: "Für ein Systemhaus.",
  version: "1.0.0",
  installed: false,
  installedAt: null,
  installedVersion: null,
  counts: { departments: 1, agents: 5, tools: 7, routines: 3 },
  integrations: [
    {
      key: "proxmox",
      label: "Proxmox VE",
      summary: "Virtualisierung lesen.",
      configured: false,
      env: [
        { name: "PROXMOX_URL", optional: false },
        { name: "PROXMOX_TOKEN_ID", optional: false },
      ],
      docsUrl: null,
    },
  ],
};

function client(over: Record<string, unknown> = {}, packs: BusinessPackSummary[] = [PACK]) {
  return {
    packs: vi.fn(async () => ({ packs })),
    pack: vi.fn(async () => ({
      pack: packs[0]!,
      departments: [],
      agents: [
        {
          key: "msp-service-desk",
          department: "service-desk",
          displayName: "Relay",
          professionalRole: "Service Desk",
          roleSummary: "Nimmt Störungen auf.",
          seniority: "junior",
          maxRiskLevel: "low",
        },
      ],
      tools: [],
      routines: [],
    })),
    installPack: vi.fn(async () => ({ ok: true, created: { agents: 5, tools: 7, routines: 3 }, reused: {} })),
    uninstallPack: vi.fn(async () => ({ ok: true, removed: { agents: 5, routines: 3 }, disabledTools: 7, kept: [] })),
    testPackIntegration: vi.fn(async () => ({ ok: true, message: "PVE 8.2" })),
    ...over,
  } as never;
}

describe("PacksPanel", () => {
  it("names the variables that would switch an unconfigured integration on", async () => {
    render(<PacksPanel onClose={() => {}} client={client()} />);
    expect(await screen.findByText(/nicht konfiguriert/)).toHaveTextContent("PROXMOX_URL");
    expect(screen.getByText(/nicht konfiguriert/)).toHaveTextContent("PROXMOX_TOKEN_ID");
  });

  it("offers a connection probe only for a configured one", async () => {
    const configured = { ...PACK, integrations: [{ ...PACK.integrations[0]!, configured: true }] };
    const { rerender } = render(<PacksPanel onClose={() => {}} client={client({}, [PACK])} />);
    await screen.findByText(/nicht konfiguriert/);
    expect(screen.queryByRole("button", { name: "Verbindung prüfen" })).toBeNull();

    rerender(<PacksPanel onClose={() => {}} client={client({}, [configured])} />);
    expect(await screen.findByRole("button", { name: "Verbindung prüfen" })).toBeTruthy();
  });

  it("shows the probe's own answer", async () => {
    const configured = { ...PACK, integrations: [{ ...PACK.integrations[0]!, configured: true }] };
    render(<PacksPanel onClose={() => {}} client={client({}, [configured])} />);
    await userEvent.click(await screen.findByRole("button", { name: "Verbindung prüfen" }));
    expect(await screen.findByText("PVE 8.2")).toBeTruthy();
  });

  it("says after installing that the routines are still off", async () => {
    render(<PacksPanel onClose={() => {}} client={client()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Installieren" }));
    expect(await screen.findByText(/erst, wenn du sie einschaltest/)).toBeTruthy();
  });

  it("reports what an uninstall kept, rather than letting it be discovered later", async () => {
    const installed = { ...PACK, installed: true };
    const uninstallPack = vi.fn(async () => ({
      ok: true,
      removed: { agents: 0, routines: 3 },
      disabledTools: 7,
      kept: [{ type: "agent", id: "agt_1", key: "msp-linux-ops", reason: "Es hängen noch 4 Aufgaben daran." }],
    }));
    render(<PacksPanel onClose={() => {}} client={client({ uninstallPack }, [installed])} />);
    await userEvent.click(await screen.findByRole("button", { name: "Entfernen" }));
    expect(await screen.findByText(/msp-linux-ops/)).toHaveTextContent("Es hängen noch 4 Aufgaben daran.");
  });

  it("shows a refusal instead of hiding the control", async () => {
    const installPack = vi.fn(async () => {
      throw new Error('Dafür wird mindestens die Rolle "owner" gebraucht.');
    });
    render(<PacksPanel onClose={() => {}} client={client({ installPack })} />);
    await userEvent.click(await screen.findByRole("button", { name: "Installieren" }));
    expect(await screen.findByText(/Rolle "owner"/)).toBeTruthy();
  });

  it("shows what a pack would add before it is installed", async () => {
    render(<PacksPanel onClose={() => {}} client={client()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Ansehen" }));
    await waitFor(() => expect(screen.getByText("Relay")).toBeTruthy());
    expect(screen.getByText(/Nimmt Störungen auf/)).toBeTruthy();
  });
});
