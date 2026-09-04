import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import IronCrewTopBar from "./IronCrewTopBar";

function createBaseProps(): ComponentProps<typeof IronCrewTopBar> {
  return {
    view: "office",
    onChangeView: vi.fn(),
    language: "en",
    onLanguageChange: vi.fn(),
    theme: "dark",
    onToggleTheme: vi.fn(),
    decisionInboxCount: 0,
    decisionInboxLoading: false,
    onOpenDecisionInbox: vi.fn(),
    onOpenAnnouncement: vi.fn(),
    onOpenAgentStatus: vi.fn(),
    onOpenReportHistory: vi.fn(),
    onOpenRoomManager: vi.fn(),
    onNewMission: vi.fn(),
    officePackControl: null,
    connected: true,
    setupStatus: null,
  };
}

function parsePx(value: string | null | undefined): number {
  if (!value) return 0;
  const num = parseFloat(value);
  return Number.isFinite(num) ? num : 0;
}

describe("IronCrewTopBar — WCAG 2.5.8 target sizes (E-005)", () => {
  it("ghost icon buttons (announcement, decision inbox, more, theme) report width and height >= 36px", () => {
    const props = createBaseProps();
    render(<IronCrewTopBar {...props} />);

    const labels = ["Announcement", "Decision Inbox", "More actions"];
    for (const label of labels) {
      const btn = screen.getByRole("button", { name: new RegExp(label, "i") }) as HTMLButtonElement;
      expect(parsePx(btn.style.width)).toBeGreaterThanOrEqual(36);
      expect(parsePx(btn.style.height)).toBeGreaterThanOrEqual(36);
    }

    // Theme toggle uses dynamic aria-label
    const themeBtn = screen.getByRole("button", { name: /switch to (light|dark) mode/i }) as HTMLButtonElement;
    expect(parsePx(themeBtn.style.width)).toBeGreaterThanOrEqual(36);
    expect(parsePx(themeBtn.style.height)).toBeGreaterThanOrEqual(36);
  });

  it("language cycle ghost button has height >= 36px (width may auto-fit text)", () => {
    const props = createBaseProps();
    render(<IronCrewTopBar {...props} />);

    const langBtn = screen.getByRole("button", { name: /current language/i }) as HTMLButtonElement;
    expect(parsePx(langBtn.style.height)).toBeGreaterThanOrEqual(36);
  });

  it("nav cluster has gap >= 6px between items", () => {
    const props = createBaseProps();
    const { container } = render(<IronCrewTopBar {...props} />);

    const nav = container.querySelector("nav") as HTMLElement | null;
    expect(nav).not.toBeNull();
    if (!nav) return;
    expect(parsePx(nav.style.gap)).toBeGreaterThanOrEqual(6);
  });

  it("nav tab buttons have height >= 36px and 2px outer margin", () => {
    const props = createBaseProps();
    render(<IronCrewTopBar {...props} />);

    const tabLabels = ["OFFICE", "TASKS", "WORKFLOWS", "OPS", "ROSTER", "LIBRARY", "PROJECTS", "SCHEDULES", "SETTINGS"];
    for (const label of tabLabels) {
      const btn = screen.getByRole("button", { name: new RegExp(`^${label}`) }) as HTMLButtonElement;
      expect(parsePx(btn.style.height)).toBeGreaterThanOrEqual(36);
      // Each tab has at least 2px outer margin to prevent abutting targets
      expect(parsePx(btn.style.margin)).toBeGreaterThanOrEqual(2);
    }
  });

  it("+ NEW MISSION button has height >= 36px", () => {
    const props = createBaseProps();
    render(<IronCrewTopBar {...props} />);

    const btn = screen.getByRole("button", { name: /new mission/i }) as HTMLButtonElement;
    expect(parsePx(btn.style.height)).toBeGreaterThanOrEqual(36);
  });

  it("pack selector (when rendered) has height >= 36px", () => {
    const props = createBaseProps();
    props.officePackControl = {
      label: "Workflow Pack",
      value: "development",
      options: [
        {
          key: "development",
          label: "Development",
          summary: "Standard dev workflow",
          slug: "DEV",
          accent: 0x34d399,
        },
      ],
      onChange: vi.fn(),
    };
    render(<IronCrewTopBar {...props} />);

    const select = screen.getByRole("combobox", { name: /workflow pack/i }) as HTMLSelectElement;
    expect(parsePx(select.style.height)).toBeGreaterThanOrEqual(36);
  });
});
