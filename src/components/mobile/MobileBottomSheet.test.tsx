import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MobileBottomSheet } from "./MobileBottomSheet";

describe("MobileBottomSheet", () => {
  it("renders children when open", () => {
    render(
      <MobileBottomSheet open onClose={vi.fn()}>
        <p>Sheet content</p>
      </MobileBottomSheet>,
    );
    expect(screen.getByText("Sheet content")).toBeInTheDocument();
  });

  it("does not render children when closed", () => {
    render(
      <MobileBottomSheet open={false} onClose={vi.fn()}>
        <p>Sheet content</p>
      </MobileBottomSheet>,
    );
    expect(screen.queryByText("Sheet content")).not.toBeInTheDocument();
  });

  it("calls onClose when backdrop is clicked", () => {
    const onClose = vi.fn();
    render(
      <MobileBottomSheet open onClose={onClose}>
        <p>Sheet content</p>
      </MobileBottomSheet>,
    );
    fireEvent.click(screen.getByTestId("bottom-sheet-backdrop"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("renders with a drag handle", () => {
    render(
      <MobileBottomSheet open onClose={vi.fn()}>
        <p>Content</p>
      </MobileBottomSheet>,
    );
    expect(screen.getByTestId("drag-handle")).toBeInTheDocument();
  });

  it("renders title when provided", () => {
    render(
      <MobileBottomSheet open onClose={vi.fn()} title="Filter">
        <p>Content</p>
      </MobileBottomSheet>,
    );
    expect(screen.getByText("Filter")).toBeInTheDocument();
  });

  it("respects maxHeight prop", () => {
    render(
      <MobileBottomSheet open onClose={vi.fn()} maxHeight="60dvh">
        <p>Content</p>
      </MobileBottomSheet>,
    );
    const sheet = screen.getByTestId("bottom-sheet-panel");
    expect(sheet.style.maxHeight).toBe("60dvh");
  });
});

describe("MobileBottomSheet accessibility", () => {
  it("renders the panel with role=dialog and aria-modal=true when open", () => {
    render(
      <MobileBottomSheet open onClose={vi.fn()} title="Settings">
        <button>Inside</button>
      </MobileBottomSheet>,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
  });

  it("links the dialog to its title via aria-labelledby when title is provided", () => {
    render(
      <MobileBottomSheet open onClose={vi.fn()} title="My Title">
        <button>Inside</button>
      </MobileBottomSheet>,
    );
    const dialog = screen.getByRole("dialog");
    const labelId = dialog.getAttribute("aria-labelledby");
    expect(labelId).toBeTruthy();
    const titleNode = document.getElementById(labelId!);
    expect(titleNode).not.toBeNull();
    expect(titleNode!.textContent).toBe("My Title");
  });

  it("falls back to aria-label when no title is provided", () => {
    render(
      <MobileBottomSheet open onClose={vi.fn()}>
        <button>Inside</button>
      </MobileBottomSheet>,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).not.toHaveAttribute("aria-labelledby");
    expect(dialog.getAttribute("aria-label")).toBeTruthy();
  });

  it("calls onClose when Escape is pressed", () => {
    const onClose = vi.fn();
    render(
      <MobileBottomSheet open onClose={onClose} title="Settings">
        <button>Inside</button>
      </MobileBottomSheet>,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("moves initial focus to the first focusable element inside the sheet", () => {
    render(
      <MobileBottomSheet open onClose={vi.fn()} title="Settings">
        <button data-testid="first-btn">First</button>
        <button data-testid="second-btn">Second</button>
      </MobileBottomSheet>,
    );
    expect(document.activeElement).toBe(screen.getByTestId("first-btn"));
  });

  it("focuses the dialog root when no focusable child is present", () => {
    render(
      <MobileBottomSheet open onClose={vi.fn()} title="Settings">
        <span>Just text</span>
      </MobileBottomSheet>,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("tabindex", "-1");
    expect(document.activeElement).toBe(dialog);
  });

  it("restores focus to the previously-focused element after close", () => {
    const Wrapper = ({ open }: { open: boolean }) => (
      <>
        <button data-testid="opener">Open</button>
        <MobileBottomSheet open={open} onClose={vi.fn()} title="Settings">
          <button data-testid="inside">Inside</button>
        </MobileBottomSheet>
      </>
    );
    const { rerender } = render(<Wrapper open={false} />);
    const opener = screen.getByTestId("opener");
    opener.focus();
    expect(document.activeElement).toBe(opener);

    rerender(<Wrapper open={true} />);
    expect(document.activeElement).toBe(screen.getByTestId("inside"));

    rerender(<Wrapper open={false} />);
    expect(document.activeElement).toBe(opener);
  });

  it("traps Tab from the last focusable back to the first", () => {
    render(
      <MobileBottomSheet open onClose={vi.fn()} title="Settings">
        <button data-testid="first-btn">First</button>
        <button data-testid="second-btn">Second</button>
        <button data-testid="last-btn">Last</button>
      </MobileBottomSheet>,
    );
    const first = screen.getByTestId("first-btn");
    const last = screen.getByTestId("last-btn");
    last.focus();
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(first);
  });

  it("traps Shift+Tab from the first focusable back to the last", () => {
    render(
      <MobileBottomSheet open onClose={vi.fn()} title="Settings">
        <button data-testid="first-btn">First</button>
        <button data-testid="second-btn">Second</button>
        <button data-testid="last-btn">Last</button>
      </MobileBottomSheet>,
    );
    const first = screen.getByTestId("first-btn");
    const last = screen.getByTestId("last-btn");
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });
});
