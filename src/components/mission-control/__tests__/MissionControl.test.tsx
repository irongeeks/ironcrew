import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// Mock heavy child components
vi.mock("../AgentSidebarPanel", () => ({
  default: ({ agents }: { agents: unknown[] }) => (
    <div data-testid="agent-sidebar">AgentSidebarPanel ({agents.length} agents)</div>
  ),
}));

vi.mock("../MiniKanban", () => ({
  default: () => <div data-testid="mini-kanban">MiniKanban</div>,
}));

vi.mock("../MetricsStrip", () => ({
  default: () => <div data-testid="metrics-strip">MetricsStrip</div>,
}));

vi.mock("../../RetroOfficeView", () => ({
  default: () => <div data-testid="retro-office-view">RetroOfficeView</div>,
}));

vi.mock("../../taskboard/CreateTaskModal", () => ({
  default: () => <div data-testid="create-task-modal">CreateTaskModal</div>,
}));

vi.mock("../../live-task-view/LiveTaskView", () => ({
  default: () => <div data-testid="live-task-view">LiveTaskView</div>,
}));

vi.mock("../../../hooks/useTokenUsage", () => ({
  useProviderTokenUsage: () => [],
}));

vi.mock("../../../hooks/useMobile", () => ({
  useMobile: () => ({ isMobile: false }),
}));

import MissionControl from "../MissionControl";

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

describe("MissionControl", () => {
  it("renders without crashing", () => {
    const { container } = render(<MissionControl {...defaultProps} />);
    expect(container.firstChild).toBeTruthy();
  });

  it("renders the three-column layout sections", () => {
    render(<MissionControl {...defaultProps} />);

    // Left column: agent sidebar
    expect(screen.getByTestId("agent-sidebar")).toBeInTheDocument();
    expect(screen.getByText("AgentSidebarPanel (2 agents)")).toBeInTheDocument();

    // Center column: office view, mini kanban, metrics strip
    expect(screen.getByTestId("retro-office-view")).toBeInTheDocument();
    expect(screen.getByTestId("mini-kanban")).toBeInTheDocument();
    expect(screen.getByTestId("metrics-strip")).toBeInTheDocument();

    // Expand button
    expect(screen.getByText("↗ Expand")).toBeInTheDocument();

    // OctoOffice label
    expect(screen.getByText("OctoOffice")).toBeInTheDocument();
  });

  it("renders LiveTaskView in the center column", () => {
    render(<MissionControl {...defaultProps} />);
    expect(screen.getByTestId("live-task-view")).toBeInTheDocument();
  });

  it("does not render CreateTaskModal by default", () => {
    render(<MissionControl {...defaultProps} />);
    expect(screen.queryByTestId("create-task-modal")).not.toBeInTheDocument();
  });

  it("renders CreateTaskModal when showCreateTask is true", () => {
    render(<MissionControl {...defaultProps} showCreateTask={true} />);
    expect(screen.getByTestId("create-task-modal")).toBeInTheDocument();
  });
});
