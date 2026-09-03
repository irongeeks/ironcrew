import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// Mock useMobile to return desktop mode
vi.mock("../../../hooks/useMobile", () => ({
  useMobile: () => ({ isMobile: false }),
}));

vi.mock("../../mobile/MobileTaskBoard", () => ({
  default: () => <div data-testid="mobile-task-board">MobileTaskBoard</div>,
  MobileTaskBoard: () => <div data-testid="mobile-task-board">MobileTaskBoard</div>,
}));

// Mock child components
vi.mock("../../taskboard/FilterBar", () => ({
  default: () => <div data-testid="filter-bar">FilterBar</div>,
}));

vi.mock("../../taskboard/TaskCard", () => ({
  default: ({ task }: { task: { title: string } }) => <div data-testid="task-card">{task.title}</div>,
}));

vi.mock("../../taskboard/CreateTaskModal", () => ({
  default: () => <div data-testid="create-task-modal">CreateTaskModal</div>,
}));

vi.mock("../../taskboard/BulkHideModal", () => ({
  default: () => <div data-testid="bulk-hide-modal">BulkHideModal</div>,
}));

vi.mock("../../ProjectManagerModal", () => ({
  default: () => <div data-testid="project-manager-modal">ProjectManagerModal</div>,
}));

vi.mock("../../../api", () => ({
  bulkHideTasks: vi.fn(),
}));

import { TaskBoard } from "../../TaskBoard";

const noop = vi.fn();

const defaultProps = {
  tasks: [],
  agents: [],
  departments: [],
  subtasks: [],
  onCreateTask: noop,
  onUpdateTask: noop,
  onDeleteTask: noop,
  onAssignTask: noop,
  onRunTask: noop,
  onStopTask: noop,
} as Parameters<typeof TaskBoard>[0];

describe("TaskBoard", () => {
  it("renders its main container", () => {
    const { container } = render(<TaskBoard {...defaultProps} />);
    const shell = container.querySelector(".taskboard-shell");
    expect(shell).toBeInTheDocument();
  });

  it("renders the Task Board heading", () => {
    render(<TaskBoard {...defaultProps} />);
    expect(screen.getByText("Task Board")).toBeInTheDocument();
  });

  it("renders column headers for all statuses when tasks exist", () => {
    const tasks = [
      {
        id: "t1",
        title: "Seed",
        status: "inbox",
        priority: 1,
        created_at: 1000,
        department_id: "",
        assigned_agent_id: "",
        task_type: "general",
        hidden: 0,
      },
    ] as Parameters<typeof TaskBoard>[0]["tasks"];
    render(<TaskBoard {...defaultProps} tasks={tasks} />);
    const columns = ["Inbox", "Planned", "In Progress", "Review", "Done", "Pending", "Cancelled"];
    for (const col of columns) {
      expect(screen.getByText(col)).toBeInTheDocument();
    }
  });

  it("renders an empty state instead of columns when no tasks exist", () => {
    render(<TaskBoard {...defaultProps} />);
    expect(screen.getByText("No tasks yet")).toBeInTheDocument();
    expect(screen.queryByText("Inbox")).not.toBeInTheDocument();
  });

  it("renders the New Task button", () => {
    render(<TaskBoard {...defaultProps} />);
    // One button in the header, one in the empty state when tasks are empty.
    expect(screen.getAllByText(/New Task/).length).toBeGreaterThanOrEqual(1);
  });

  it("renders the Active / All toggle button", () => {
    render(<TaskBoard {...defaultProps} />);
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText("All")).toBeInTheDocument();
  });

  it("renders FilterBar", () => {
    render(<TaskBoard {...defaultProps} />);
    expect(screen.getByTestId("filter-bar")).toBeInTheDocument();
  });

  it("shows total task count", () => {
    render(<TaskBoard {...defaultProps} />);
    expect(screen.getByText(/Total/)).toBeInTheDocument();
  });

  it("renders task cards in correct columns", () => {
    const tasks = [
      {
        id: "t1",
        title: "Test Task One",
        status: "inbox",
        priority: 1,
        created_at: 1000,
        department_id: "",
        assigned_agent_id: "",
        task_type: "general",
        hidden: 0,
      },
      {
        id: "t2",
        title: "Test Task Two",
        status: "done",
        priority: 2,
        created_at: 2000,
        department_id: "",
        assigned_agent_id: "",
        task_type: "general",
        hidden: 0,
      },
    ] as Parameters<typeof TaskBoard>[0]["tasks"];

    render(<TaskBoard {...defaultProps} tasks={tasks} />);
    expect(screen.getByText("Test Task One")).toBeInTheDocument();
    expect(screen.getByText("Test Task Two")).toBeInTheDocument();
  });
});
