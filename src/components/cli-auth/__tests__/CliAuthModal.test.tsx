import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import CliAuthModal from "../CliAuthModal";

// Mock the terminal component entirely (xterm.js needs canvas + ResizeObserver)
vi.mock("../CliAuthTerminal", () => ({
  default: ({ provider }: { provider: string }) => <div data-testid="cli-auth-terminal">{provider} terminal</div>,
}));

// Mock the API module
vi.mock("../../../api", () => ({
  startCliAuth: vi.fn().mockResolvedValue({ sessionId: "test-id" }),
  pollCliAuthStatus: vi.fn().mockResolvedValue({ status: "pending", authenticated: false, error: null }),
  cancelCliAuth: vi.fn().mockResolvedValue({ cancelled: true }),
  saveCodexApiKey: vi.fn().mockResolvedValue({ authenticated: true }),
}));

// Mock i18n
vi.mock("../../../i18n", () => ({
  useI18n: () => ({
    t: (msgs: Record<string, string>) => msgs.en ?? Object.values(msgs)[0],
  }),
}));

describe("CliAuthModal", () => {
  it("renders nothing when not open", () => {
    const { container } = render(<CliAuthModal provider="claude" open={false} onClose={vi.fn()} onSuccess={vi.fn()} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders modal with provider name when open", () => {
    render(<CliAuthModal provider="claude" open={true} onClose={vi.fn()} onSuccess={vi.fn()} />);
    expect(screen.getByText("Claude Code Authentication")).toBeDefined();
  });

  it("shows method picker for codex", () => {
    render(<CliAuthModal provider="codex" open={true} onClose={vi.fn()} onSuccess={vi.fn()} />);
    expect(screen.getByText("ChatGPT Account")).toBeDefined();
    expect(screen.getByText("API Key")).toBeDefined();
  });
});
