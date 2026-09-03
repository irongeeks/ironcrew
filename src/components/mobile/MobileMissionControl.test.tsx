import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// Mock heavy child components
vi.mock("../RetroOfficeView", () => ({
  default: () => <div data-testid="retro-office-view">RetroOfficeView</div>,
}));

vi.mock("../mission-control/AgentSidebarPanel", () => ({
  default: ({ agents }: { agents: unknown[] }) => (
    <div data-testid="agent-sidebar">AgentSidebarPanel ({agents.length} agents)</div>
  ),
}));

vi.mock("../mission-control/MiniKanban", () => ({
  default: () => <div data-testid="mini-kanban">MiniKanban</div>,
}));

vi.mock("../mission-control/MetricsStrip", () => ({
  default: () => <div data-testid="metrics-strip">MetricsStrip</div>,
}));

vi.mock("../../hooks/useTokenUsage", () => ({
  useProviderTokenUsage: () => null,
}));

import { MobileMissionControl } from "./MobileMissionControl";

const defaultProps = {
  agents: [
    { id: "a1", name: "Alice", department_id: "d1", role: "developer", cli_provider: "claude" },
    { id: "a2", name: "Bob", department_id: "d1", role: "designer", cli_provider: "gemini" },
  ] as never[],
  tasks: [] as never[],
  departments: [{ id: "d1", name: "Dev", description: "Development" }] as never[],
  servers: [] as never[],
  serverAllocations: [] as never[],
  subtasks: [] as never[],
  socketOn: vi.fn(() => vi.fn()),
  onAgentClick: vi.fn(),
  onSelectDepartment: vi.fn(),
  onSelectServer: vi.fn(),
  onTaskClick: vi.fn(),
  onCreateTask: vi.fn(),
  onAssignTask: vi.fn().mockResolvedValue(undefined),
  onFullBoard: vi.fn(),
  onExpandOffice: vi.fn(),
};

describe("MobileMissionControl", () => {
  it("renders the office canvas", () => {
    render(<MobileMissionControl {...defaultProps} />);
    expect(screen.getByTestId("retro-office-view")).toBeInTheDocument();
  });

  it("renders segment tabs (Agents, Kanban, Metrics)", () => {
    render(<MobileMissionControl {...defaultProps} />);
    expect(screen.getByText("Agents")).toBeInTheDocument();
    expect(screen.getByText("Kanban")).toBeInTheDocument();
    expect(screen.getByText("Metrics")).toBeInTheDocument();
  });

  it("defaults to Agents tab", () => {
    render(<MobileMissionControl {...defaultProps} />);
    expect(screen.getByTestId("agent-sidebar")).toBeInTheDocument();
    expect(screen.queryByTestId("mini-kanban")).not.toBeInTheDocument();
    expect(screen.queryByTestId("metrics-strip")).not.toBeInTheDocument();
  });

  it("switches to Kanban tab when tapped", () => {
    render(<MobileMissionControl {...defaultProps} />);
    fireEvent.click(screen.getByText("Kanban"));
    expect(screen.getByTestId("mini-kanban")).toBeInTheDocument();
    expect(screen.queryByTestId("agent-sidebar")).not.toBeInTheDocument();
    expect(screen.queryByTestId("metrics-strip")).not.toBeInTheDocument();
  });

  it("switches to Metrics tab when tapped", () => {
    render(<MobileMissionControl {...defaultProps} />);
    fireEvent.click(screen.getByText("Metrics"));
    expect(screen.getByTestId("metrics-strip")).toBeInTheDocument();
    expect(screen.queryByTestId("agent-sidebar")).not.toBeInTheDocument();
    expect(screen.queryByTestId("mini-kanban")).not.toBeInTheDocument();
  });
});
