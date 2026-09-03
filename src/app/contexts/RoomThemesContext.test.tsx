import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import type { RoomTheme } from "../../types";
import type { RoomThemeMap } from "../types";
import { ROOM_THEMES_STORAGE_KEY } from "../constants";
import { RoomThemesProvider, useRoomThemes } from "./RoomThemesContext";

vi.mock("../../api", () => ({
  saveRoomThemes: vi.fn(() => Promise.resolve()),
}));

import { saveRoomThemes } from "../../api";

const sampleTheme: RoomTheme = { floor1: 1, floor2: 2, wall: 3, accent: 4 };

function Probe(): ReactNode {
  const ctx = useRoomThemes();
  return (
    <div>
      <span data-testid="active">{ctx.activeRoomThemeTargetId ?? "(none)"}</span>
      <span data-testid="count">{Object.keys(ctx.customRoomThemes).length}</span>
      <span data-testid="hasLocal">{ctx.hasLocalRoomThemesRef.current ? "1" : "0"}</span>
      <button data-testid="setActive" onClick={() => ctx.setActiveRoomThemeTargetId("planning")} />
      <button
        data-testid="setThemes"
        onClick={() => ctx.handleRoomThemeChange({ planning: sampleTheme } satisfies RoomThemeMap)}
      />
    </div>
  );
}

describe("RoomThemesContext", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.mocked(saveRoomThemes).mockClear();
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it("provides initial empty themes when no stored values exist", () => {
    render(
      <RoomThemesProvider>
        <Probe />
      </RoomThemesProvider>,
    );
    expect(screen.getByTestId("count").textContent).toBe("0");
    expect(screen.getByTestId("hasLocal").textContent).toBe("0");
    expect(screen.getByTestId("active").textContent).toBe("(none)");
  });

  it("hydrates from storage and exposes hasLocalRoomThemesRef as true", () => {
    window.localStorage.setItem(ROOM_THEMES_STORAGE_KEY, JSON.stringify({ planning: sampleTheme }));
    render(
      <RoomThemesProvider>
        <Probe />
      </RoomThemesProvider>,
    );
    expect(screen.getByTestId("count").textContent).toBe("1");
    expect(screen.getByTestId("hasLocal").textContent).toBe("1");
  });

  it("updates active room theme target id", async () => {
    const user = userEvent.setup();
    render(
      <RoomThemesProvider>
        <Probe />
      </RoomThemesProvider>,
    );
    await user.click(screen.getByTestId("setActive"));
    expect(screen.getByTestId("active").textContent).toBe("planning");
  });

  it("handleRoomThemeChange updates state, persists to localStorage, and saves to API", async () => {
    render(
      <RoomThemesProvider>
        <Probe />
      </RoomThemesProvider>,
    );
    await act(async () => {
      screen.getByTestId("setThemes").click();
    });
    expect(screen.getByTestId("count").textContent).toBe("1");
    expect(screen.getByTestId("hasLocal").textContent).toBe("1");
    const stored = window.localStorage.getItem(ROOM_THEMES_STORAGE_KEY);
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored as string)).toEqual({ planning: sampleTheme });
    expect(saveRoomThemes).toHaveBeenCalledWith({ planning: sampleTheme });
  });

  it("throws if useRoomThemes is used outside provider", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow();
    spy.mockRestore();
  });
});
