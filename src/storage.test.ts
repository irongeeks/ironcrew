import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readStoredValue, writeStoredValue } from "./storage";

const originalLocalStorage = window.localStorage;

function useLocalStorage(storage: Storage) {
  Object.defineProperty(window, "localStorage", { value: storage, configurable: true });
}

describe("browser storage across the rename", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    useLocalStorage(originalLocalStorage);
    window.localStorage.clear();
  });

  it("reads a value stored under the current key", () => {
    window.localStorage.setItem("ironcrew_theme", "dark");
    expect(readStoredValue("ironcrew_theme")).toBe("dark");
  });

  it("adopts a value left under the pre-rename key, and clears the old one", () => {
    window.localStorage.setItem("octooffice_theme", "dark");

    expect(readStoredValue("ironcrew_theme")).toBe("dark");
    expect(window.localStorage.getItem("ironcrew_theme")).toBe("dark");
    expect(window.localStorage.getItem("octooffice_theme")).toBeNull();
  });

  it("prefers the current key when both are present", () => {
    window.localStorage.setItem("ironcrew.language", "de");
    window.localStorage.setItem("octooffice.language", "ko");

    expect(readStoredValue("ironcrew.language")).toBe("de");
  });

  it("returns null rather than throwing when the browser blocks storage", () => {
    useLocalStorage({
      getItem() {
        throw new Error("blocked");
      },
    } as unknown as Storage);

    expect(readStoredValue("ironcrew_theme")).toBeNull();
  });

  it("swallows a failed write so a full quota cannot break the action", () => {
    const setItem = vi.fn(() => {
      throw new Error("quota exceeded");
    });
    useLocalStorage({ getItem: () => null, setItem } as unknown as Storage);

    expect(() => writeStoredValue("ironcrew_theme", "dark")).not.toThrow();
    expect(setItem).toHaveBeenCalled();
  });

  it("writes only the current key", () => {
    writeStoredValue("ironcrew_room_themes", "{}");

    expect(window.localStorage.getItem("ironcrew_room_themes")).toBe("{}");
    expect(window.localStorage.getItem("octooffice_room_themes")).toBeNull();
  });
});
