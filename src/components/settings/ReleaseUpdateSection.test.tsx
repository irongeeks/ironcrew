import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReleaseUpdateSection } from "./ReleaseUpdateSection";
import { getUpdateStatus, type UpdateStatus } from "../../api/messaging-runtime-oauth";

vi.mock("../../api/messaging-runtime-oauth", () => ({ getUpdateStatus: vi.fn() }));
const snapshot: UpdateStatus = {
  current_version: "2.7.0",
  latest_version: "2.8.0",
  latest_tag: "v2.8.0",
  install_type: "native",
  channel: "stable",
  discovery: "available",
  self_update_supported: false,
  update_available: true,
  release_url: "https://github.com/irongeeks/ironcrew/releases/tag/v2.8.0",
  checked_at: 1700000000000,
  enabled: true,
  repo: "irongeeks/ironcrew",
  error: null,
  instructions: {
    command: "node scripts/ironcrew-update.mjs --to v2.8.0 --check",
    steps: ["Nach erfolgreicher Vorprüfung den Dienst stoppen."],
    documentation_url: "https://github.com/irongeeks/ironcrew/blob/main/docs/RELEASES.md",
  },
};
beforeEach(() => {
  vi.mocked(getUpdateStatus).mockReset().mockResolvedValue(snapshot);
});
describe("ReleaseUpdateSection", () => {
  it("shows installed and stable versions plus manual native instructions without apply controls", async () => {
    render(<ReleaseUpdateSection />);
    expect(await screen.findByText("v2.7.0")).toBeInTheDocument();
    expect(screen.getByText("v2.8.0")).toBeInTheDocument();
    expect(screen.getByText("Nativer Dienst")).toBeInTheDocument();
    expect(screen.getByText(snapshot.instructions!.command!)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Release-Hinweise öffnen" })).toHaveAttribute("href", snapshot.release_url);
    expect(screen.getAllByRole("button")).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Stable Release prüfen" }));
    expect(getUpdateStatus).toHaveBeenLastCalledWith(true);
  });
  it("shows Docker-specific backup and preflight instructions", async () => {
    vi.mocked(getUpdateStatus).mockResolvedValue({
      ...snapshot,
      install_type: "docker",
      instructions: {
        ...snapshot.instructions!,
        command: "node scripts/ironcrew-docker-update.mjs --to v2.8.0 --backup-dir /ABS/backups --check",
      },
    });
    render(<ReleaseUpdateSection />);
    expect(await screen.findByText("Docker Compose")).toBeInTheDocument();
    expect(screen.getByText(/ironcrew-docker-update.mjs/)).toHaveTextContent("--backup-dir /ABS/backups --check");
  });
  it.each([
    {
      error: "github_http_503",
      discovery: "unavailable" as const,
      message: "Release-Prüfung fehlgeschlagen; der aktuelle Release-Stand ist unbekannt.",
    },
    { error: null, discovery: "no_release" as const, message: "Noch kein veröffentlichtes Stable Release vorhanden." },
  ])("does not claim current status when discovery is $discovery", async ({ error, discovery, message }) => {
    vi.mocked(getUpdateStatus).mockResolvedValue({
      ...snapshot,
      error,
      discovery,
      latest_version: null,
      latest_tag: null,
      release_url: null,
      update_available: false,
      instructions: { ...snapshot.instructions!, command: null },
    });
    render(<ReleaseUpdateSection />);
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.queryByText(/Kein neueres Stable Release/)).not.toBeInTheDocument();
    expect(screen.queryByText(/node scripts/)).not.toBeInTheDocument();
  });
});
