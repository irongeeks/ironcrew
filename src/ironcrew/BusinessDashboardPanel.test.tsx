import { I18nProvider } from "../i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render as rtlRender, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BusinessDashboardPanel } from "./BusinessDashboardPanel";
import type { BusinessDashboardSnapshot } from "../shared/business-dashboard";
afterEach(cleanup);
function fixture(): BusinessDashboardSnapshot {
  return {
    agents: [{ id: "agent-a", displayName: "Atlas" }],
    sources: [
      {
        id: "proxmox",
        label: "Proxmox · Gäste",
        packKey: "msp",
        integration: "proxmox",
        toolKey: "proxmox.inventory",
        endpoint: "GET /api2/json/cluster/resources?type=vm",
        state: "not_refreshed",
        fetchedAt: null,
        attemptedAt: null,
        message: "Noch nicht abgerufen.",
        metrics: [],
        records: [],
        limited: false,
      },
    ],
  };
}
function client(snapshot = fixture()) {
  return { load: vi.fn(async () => snapshot), refresh: vi.fn(async () => snapshot) };
}
describe("business dashboard source visibility", () => {
  it("loads cached state without refreshing and requires a deliberate agent selection", async () => {
    const api = client();
    render(<BusinessDashboardPanel onClose={() => {}} client={api} />);
    const button = await screen.findByRole("button", { name: "Proxmox · Gäste aktualisieren" });
    expect(button).toBeDisabled();
    expect(api.refresh).not.toHaveBeenCalled();
    await userEvent.selectOptions(screen.getByLabelText("Mitarbeiter für den Abruf"), "agent-a");
    await userEvent.click(button);
    expect(api.refresh).toHaveBeenCalledWith("proxmox", "agent-a");
  });
  it("never displays unconfigured or failed data as zero", async () => {
    const data = fixture();
    data.sources[0]!.state = "not_configured";
    data.sources[0]!.message = "Zugang auf dem Host einrichten.";
    render(<BusinessDashboardPanel onClose={() => {}} client={client(data)} />);
    expect(await screen.findByText("Nicht konfiguriert")).toBeVisible();
    expect(screen.queryByRole("definition")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Proxmox · Gäste aktualisieren" })).toBeDisabled();
  });
  it("exposes source, timestamp, bounded rows and an honest observed zero", async () => {
    const data = fixture();
    Object.assign(data.sources[0]!, {
      state: "ok",
      fetchedAt: 1750000000000,
      limited: true,
      metrics: [{ key: "stopped", label: "Status stopped", value: 0, unit: "count" }],
      records: [{ id: "vm-7", label: "Build 7", status: "running" }],
    });
    render(<BusinessDashboardPanel onClose={() => {}} client={client(data)} />);
    expect(await screen.findByText("Status stopped")).toBeVisible();
    expect(screen.getByText("0")).toBeVisible();
    expect(screen.getByText(/Datenstand/)).toBeVisible();
    expect(screen.getByText(/Quelle: proxmox/)).toBeVisible();
    await userEvent.click(screen.getByText("Datengrundlage ansehen (1, begrenzt)"));
    expect(within(screen.getByRole("table")).getByText("Build 7")).toBeVisible();
  });
  it("shows failed load with retry rather than invented metrics", async () => {
    const api = client();
    api.load.mockRejectedValueOnce(new Error("offline"));
    render(<BusinessDashboardPanel onClose={() => {}} client={api} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("konnten nicht geladen");
    await userEvent.click(screen.getByRole("button", { name: "Erneut laden" }));
    expect(await screen.findByLabelText("Mitarbeiter für den Abruf")).toBeVisible();
  });
});

function render(ui: Parameters<typeof rtlRender>[0], options?: Parameters<typeof rtlRender>[1]) {
  return rtlRender(ui, {
    wrapper: ({ children }) => <I18nProvider language="de">{children}</I18nProvider>,
    ...options,
  });
}

it("switches business controls and locale formatting while preserving source records", async () => {
  const data = fixture();
  Object.assign(data.sources[0]!, {
    state: "ok",
    fetchedAt: 1750000000000,
    metrics: [{ key: "guests", label: "Gäste ohne Templates", value: 1234, unit: "count" }],
    records: [{ id: "source-a", label: "Kundenserver", status: "running" }],
  });
  const api = client(data);
  const view = rtlRender(
    <I18nProvider language="en">
      <BusinessDashboardPanel onClose={() => {}} client={api} />
    </I18nProvider>,
  );
  expect(await screen.findByText("Data available")).toBeVisible();
  expect(screen.getByText("1,234")).toBeVisible();
  expect(screen.getByRole("heading", { name: "Proxmox · Guests" })).toBeVisible();
  expect(screen.getByText("Guests excluding templates")).toBeVisible();
  expect(screen.getByText("Selection returned by the source system. No projections.")).toBeVisible();
  view.rerender(
    <I18nProvider language="de">
      <BusinessDashboardPanel onClose={() => {}} client={api} />
    </I18nProvider>,
  );
  expect(await screen.findByText("Daten vorhanden")).toBeVisible();
  expect(screen.getByText("1.234")).toBeVisible();
  expect(screen.getByText("Kundenserver")).toBeInTheDocument();
  expect(api.refresh).not.toHaveBeenCalled();
});
