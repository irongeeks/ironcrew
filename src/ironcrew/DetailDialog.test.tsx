import { StrictMode, useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DetailDialog, dialogTabStops } from "./DetailDialog";

afterEach(cleanup);

describe("DetailDialog component responsibilities (not native browser emulation)", () => {
  it("labels the dialog, focuses its heading once, and restores the opener", () => {
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();
    const { rerender, unmount } = render(
      <StrictMode>
        <DetailDialog title="Modellprofile" onClose={vi.fn()}>
          <input aria-label="Modell" />
        </DetailDialog>
      </StrictMode>,
    );
    expect(screen.getByRole("dialog", { name: "Modellprofile" })).toHaveAttribute("open");
    expect(screen.getByRole("heading", { name: "Modellprofile" })).toHaveFocus();
    screen.getByRole("textbox").focus();
    rerender(
      <StrictMode>
        <DetailDialog title="Modellprofile aktualisiert" onClose={vi.fn()}>
          <input aria-label="Modell" />
        </DetailDialog>
      </StrictMode>,
    );
    expect(screen.getByRole("textbox")).toHaveFocus();
    unmount();
    expect(trigger).toHaveFocus();
    trigger.remove();
  });

  it("contains Tab boundaries with fresh enabled controls, including heading and dynamically removed focus", () => {
    const { rerender } = render(
      <DetailDialog title="Profil" onClose={vi.fn()}>
        <input aria-label="Erstes Feld" />
        <button disabled>Deaktiviert</button>
      </DetailDialog>,
    );
    const dialog = screen.getByRole("dialog");
    const first = screen.getByRole("textbox");
    const last = screen.getByRole("button", { name: "Schliessen" });
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(last).toHaveFocus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(first).toHaveFocus();
    rerender(
      <DetailDialog title="Profil" onClose={vi.fn()}>
        <input aria-label="Erstes Feld" disabled />
        <input aria-label="Neues Feld" />
      </DetailDialog>,
    );
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(screen.getByRole("textbox", { name: "Neues Feld" })).toHaveFocus();
  });

  it("ignores cancellation of a lower modal and uses the latest close callback", () => {
    const closeOuter = vi.fn();
    const closeInner = vi.fn();
    const updatedClose = vi.fn();
    const content = (onClose: () => void) => (
      <>
        <DetailDialog title="Firma" onClose={closeOuter}>
          Firma
        </DetailDialog>
        <DetailDialog title="Mitarbeiter" onClose={onClose}>
          Inhalt
        </DetailDialog>
      </>
    );
    const { rerender } = render(content(closeInner));
    const outer = screen.getByRole("dialog", { name: "Firma" });
    const inner = screen.getByRole("dialog", { name: "Mitarbeiter" });
    fireEvent(outer, new Event("cancel", { bubbles: false, cancelable: true }));
    expect(closeOuter).not.toHaveBeenCalled();
    rerender(content(updatedClose));
    fireEvent(inner, new Event("cancel", { bubbles: false, cancelable: true }));
    expect(closeInner).not.toHaveBeenCalled();
    expect(updatedClose).toHaveBeenCalledTimes(1);
  });

  it("closes only the nested modal and restores the parent control after a real component interaction", () => {
    function Example() {
      const [nested, setNested] = useState(false);
      return (
        <DetailDialog title="Firma" onClose={vi.fn()}>
          <button onClick={() => setNested(true)}>Profil öffnen</button>
          {nested && (
            <DetailDialog title="Profil" onClose={() => setNested(false)}>
              Details
            </DetailDialog>
          )}
        </DetailDialog>
      );
    }
    render(<Example />);
    const opener = screen.getByRole("button", { name: "Profil öffnen" });
    opener.focus();
    fireEvent.click(opener);
    fireEvent(screen.getByRole("dialog", { name: "Profil" }), new Event("cancel", { cancelable: true }));
    expect(screen.queryByRole("dialog", { name: "Profil" })).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("isolates Escape from legacy window handlers without replacing native cancellation", () => {
    const close = vi.fn();
    const backgroundKey = vi.fn();
    window.addEventListener("keydown", backgroundKey);
    try {
      render(
        <DetailDialog title="Firma" onClose={close}>
          Inhalt
        </DetailDialog>,
      );
      const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
      fireEvent(screen.getByRole("heading"), event);
      expect(backgroundKey).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(false);
      expect(close).not.toHaveBeenCalled();
      fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("keydown", backgroundKey);
    }
  });

  it("does not focus a removed trigger during teardown", () => {
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();
    const { unmount } = render(
      <DetailDialog title="Firma" onClose={vi.fn()}>
        Inhalt
      </DetailDialog>,
    );
    trigger.remove();
    const focus = vi.spyOn(trigger, "focus");
    unmount();
    expect(focus).not.toHaveBeenCalled();
  });
});

describe("dialogTabStops", () => {
  it("excludes hidden ancestors, disabled fieldsets and collapsed details while respecting radio groups and tabindex", () => {
    const { container } = render(
      <div>
        <button tabIndex={2}>Zweite Priorität</button>
        <button tabIndex={1}>Erste Priorität</button>
        <button>Normal</button>
        <button hidden>Versteckt</button>
        <div style={{ display: "none" }}>
          <button>Unsichtbarer Bereich</button>
        </div>
        <button style={{ visibility: "hidden" }}>Unsichtbar</button>
        <button tabIndex={-1}>Programmatisch</button>
        <fieldset disabled>
          <input aria-label="Gesperrt" />
        </fieldset>
        <details>
          <summary>Verlauf</summary>
          <button>Zugeklappt</button>
        </details>
        <input type="radio" name="profil" aria-label="Schnell" />
        <input type="radio" name="profil" aria-label="Tief" defaultChecked />
        <input type="hidden" />
      </div>,
    );
    expect(dialogTabStops(container).map((node) => node.getAttribute("aria-label") ?? node.textContent)).toEqual([
      "Erste Priorität",
      "Zweite Priorität",
      "Normal",
      "Verlauf",
      "Tief",
    ]);
  });
});
