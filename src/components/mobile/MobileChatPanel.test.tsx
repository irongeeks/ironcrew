import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// Mock heavy child components
vi.mock("../chat-panel/ChatMessageList", () => ({
  default: () => <div data-testid="chat-message-list">Messages</div>,
}));
vi.mock("../chat-panel/ChatComposer", () => ({
  default: () => <div data-testid="chat-composer">Composer</div>,
}));
vi.mock("../chat-panel/ChatPanelHeader", () => ({
  default: () => <div data-testid="chat-panel-header">Header</div>,
}));
vi.mock("../chat-panel/ProjectFlowDialog", () => ({
  default: () => null,
}));
vi.mock("../AgentAvatar", () => ({
  buildSpriteMap: () => new Map(),
}));
vi.mock("../../i18n", () => ({
  useI18n: () => ({ t: (v: unknown) => (typeof v === "string" ? v : (v as { en: string }).en), locale: "en" }),
}));
vi.mock("../../api", () => ({
  createProject: vi.fn(),
  getProjects: vi.fn().mockResolvedValue({ projects: [] }),
  isApiRequestError: () => false,
}));
vi.mock("../chat/decision-request", () => ({
  parseDecisionRequest: () => null,
}));
vi.mock("../chat-panel/useDecisionReply", () => ({
  useDecisionReplyHandlers: () => ({
    handleDecisionOptionReply: vi.fn(),
    handleDecisionManualDraft: vi.fn(),
  }),
}));

import { MobileChatPanel } from "./MobileChatPanel";

const noop = vi.fn();

const defaultProps: Parameters<typeof MobileChatPanel>[0] = {
  selectedAgent: null,
  messages: [],
  agents: [],
  onSendMessage: noop,
  onSendAnnouncement: noop,
  onSendDirective: noop,
  onClose: noop,
};

describe("MobileChatPanel", () => {
  it("renders a back button with min-h-[44px]", () => {
    render(<MobileChatPanel {...defaultProps} />);
    const backButton = screen.getByRole("button", { name: /back/i });
    expect(backButton).toBeInTheDocument();
    expect(backButton.className).toContain("min-h-[44px]");
  });

  it("renders the announcement header when no agent is selected", () => {
    render(<MobileChatPanel {...defaultProps} />);
    expect(screen.getByText(/company announcement/i)).toBeInTheDocument();
  });

  it("calls onClose when back button is tapped", () => {
    const onClose = vi.fn();
    render(<MobileChatPanel {...defaultProps} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: /back/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders message list area", () => {
    render(<MobileChatPanel {...defaultProps} />);
    expect(screen.getByTestId("chat-message-list")).toBeInTheDocument();
  });

  it("renders composer area", () => {
    render(<MobileChatPanel {...defaultProps} />);
    expect(screen.getByTestId("chat-composer")).toBeInTheDocument();
  });

  it("hides the agent-picker button when onSelectAgent is not provided", () => {
    render(<MobileChatPanel {...defaultProps} />);
    expect(screen.queryByRole("button", { name: /select agent/i })).not.toBeInTheDocument();
  });

  it("shows the agent-picker button when onSelectAgent is provided", () => {
    render(<MobileChatPanel {...defaultProps} onSelectAgent={vi.fn()} />);
    expect(screen.getByRole("button", { name: /select agent/i })).toBeInTheDocument();
  });
});
