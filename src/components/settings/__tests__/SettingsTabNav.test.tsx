import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SettingsTabNav from "../SettingsTabNav";

const t = (msgs: Record<string, string>) => msgs.en ?? "";

describe("SettingsTabNav — mobile drawer", () => {
  it("shows menu trigger button with current tab name on mobile", () => {
    render(
      <SettingsTabNav
        tab="general"
        setTab={vi.fn()}
        t={t}
        isMobile={true}
        drawerOpen={false}
        onToggleDrawer={vi.fn()}
      />,
    );

    const trigger = screen.getByRole("button", { name: /settings menu/i });
    expect(trigger).toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("General")).toBeInTheDocument();
  });

  it("calls onToggleDrawer when trigger button is clicked", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(
      <SettingsTabNav
        tab="general"
        setTab={vi.fn()}
        t={t}
        isMobile={true}
        drawerOpen={false}
        onToggleDrawer={onToggle}
      />,
    );

    await user.click(screen.getByRole("button", { name: /settings menu/i }));
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("renders drawer with all tabs when drawerOpen is true", () => {
    render(
      <SettingsTabNav
        tab="general"
        setTab={vi.fn()}
        t={t}
        isMobile={true}
        drawerOpen={true}
        onToggleDrawer={vi.fn()}
      />,
    );

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByText("CLI Tools")).toBeInTheDocument();
    expect(screen.getByText("Observability")).toBeInTheDocument();
  });

  it("selects a tab and calls onToggleDrawer to close drawer", async () => {
    const user = userEvent.setup();
    const setTab = vi.fn();
    const onToggle = vi.fn();
    render(
      <SettingsTabNav
        tab="general"
        setTab={setTab}
        t={t}
        isMobile={true}
        drawerOpen={true}
        onToggleDrawer={onToggle}
      />,
    );

    await user.click(screen.getByText("API"));
    expect(setTab).toHaveBeenCalledWith("api");
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("closes drawer on Escape key", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(
      <SettingsTabNav
        tab="general"
        setTab={vi.fn()}
        t={t}
        isMobile={true}
        drawerOpen={true}
        onToggleDrawer={onToggle}
      />,
    );

    await user.keyboard("{Escape}");
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("closes drawer on backdrop click", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(
      <SettingsTabNav
        tab="general"
        setTab={vi.fn()}
        t={t}
        isMobile={true}
        drawerOpen={true}
        onToggleDrawer={onToggle}
      />,
    );

    const backdrop = screen.getByRole("presentation");
    await user.click(backdrop);
    expect(onToggle).toHaveBeenCalledOnce();
  });
});

describe("SettingsTabNav — desktop sidebar", () => {
  it("renders all tabs in a vertical sidebar", () => {
    render(
      <SettingsTabNav
        tab="general"
        setTab={vi.fn()}
        t={t}
        isMobile={false}
        drawerOpen={false}
        onToggleDrawer={vi.fn()}
      />,
    );

    expect(screen.getByText("General")).toBeInTheDocument();
    expect(screen.getByText("Observability")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
