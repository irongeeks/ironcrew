import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { lazyFeature } from "./lazyFeature";

describe("lazyFeature", () => {
  it("defers downloading a closed feature, preserves the shell and forwards props after loading", async () => {
    let resolve!: (module: { default: (props: { title: string }) => React.ReactNode }) => void;
    const load = vi.fn(
      () =>
        new Promise<{ default: (props: { title: string }) => React.ReactNode }>((done) => {
          resolve = done;
        }),
    );
    const Feature = lazyFeature(load);
    function Shell({ open }: { open: boolean }) {
      return (
        <I18nProvider language="de">
          <nav>Navigation</nav>
          {open && <Feature title="Projektplanung" />}
        </I18nProvider>
      );
    }
    const { rerender } = render(<Shell open={false} />);
    expect(load).not.toHaveBeenCalled();
    rerender(<Shell open />);
    expect(load).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status")).toHaveTextContent("Wird geladen");
    expect(screen.getByRole("navigation")).toBeVisible();
    await act(async () => {
      resolve({ default: ({ title }) => <h2>{title}</h2> });
    });
    expect(screen.getByRole("heading", { name: "Projektplanung" })).toBeVisible();
    rerender(<Shell open={false} />);
    rerender(<Shell open />);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("isolates a rejected chunk and provides an English reload action", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const Feature = lazyFeature<object>(() =>
        Promise.reject(new Error("Failed to fetch dynamically imported module")),
      );
      render(
        <I18nProvider language="en">
          <nav>Navigation</nav>
          <Feature />
        </I18nProvider>,
      );
      expect(await screen.findByRole("alert")).toHaveTextContent("This section could not be loaded.");
      expect(screen.getByRole("button", { name: "Reload page" })).toBeVisible();
      expect(screen.getByRole("navigation")).toBeVisible();
    } finally {
      log.mockRestore();
    }
  });
});
