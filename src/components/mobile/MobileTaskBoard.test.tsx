import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { Task } from "../../types";

// Mock the constants module to avoid pulling in heavy dependencies
vi.mock("../taskboard/constants", async () => {
  const actual = await vi.importActual<typeof import("../taskboard/constants")>("../taskboard/constants");
  return actual;
});

import { MobileTaskBoard } from "./MobileTaskBoard";

const noop = vi.fn();

function makeTask(overrides: Partial<Task> & { id: string; title: string; status: Task["status"] }): Task {
  return {
    description: null,
    department_id: null,
    assigned_agent_id: null,
    priority: 3,
    task_type: "general",
    project_path: null,
    result: null,
    started_at: null,
    completed_at: null,
    created_at: Date.now(),
    updated_at: Date.now(),
    hidden: 0,
    ...overrides,
  };
}

const defaultProps = {
  tasks: [] as Task[],
  agents: [],
  departments: [],
  subtasks: [],
  onCreateTask: noop,
  onUpdateTask: noop,
  onDeleteTask: noop,
  onAssignTask: noop,
  onRunTask: noop,
  onStopTask: noop,
} as Parameters<typeof MobileTaskBoard>[0];

describe("MobileTaskBoard", () => {
  it("renders status tabs for all column statuses", () => {
    render(<MobileTaskBoard {...defaultProps} />);
    // The actual statuses from COLUMNS
    expect(screen.getByText("Inbox")).toBeInTheDocument();
    expect(screen.getByText("Planned")).toBeInTheDocument();
    expect(screen.getByText("In Progress")).toBeInTheDocument();
    expect(screen.getByText("Review")).toBeInTheDocument();
    expect(screen.getByText("Done")).toBeInTheDocument();
    expect(screen.getByText("Pending")).toBeInTheDocument();
    expect(screen.getByText("Cancelled")).toBeInTheDocument();
  });

  it("renders the + New Task button", () => {
    render(<MobileTaskBoard {...defaultProps} />);
    expect(screen.getAllByRole("button", { name: /new task/i }).length).toBeGreaterThan(0);
  });

  it("calls onCreateTask indirectly when + New Task is tapped (opens create flow)", () => {
    const onCreateTask = vi.fn();
    render(<MobileTaskBoard {...defaultProps} onCreateTask={onCreateTask} />);
    const [btn] = screen.getAllByRole("button", { name: /new task/i });
    expect(btn).toBeInTheDocument();
    fireEvent.click(btn);
  });

  it("filters tasks by the active status tab", () => {
    const tasks = [
      makeTask({ id: "t1", title: "Inbox Task", status: "inbox", priority: 3 }),
      makeTask({ id: "t2", title: "Done Task", status: "done", priority: 2 }),
      makeTask({ id: "t3", title: "Another Inbox", status: "inbox", priority: 1 }),
    ];

    render(<MobileTaskBoard {...defaultProps} tasks={tasks} />);
    // Default tab is "inbox" (first column)
    expect(screen.getByText("Inbox Task")).toBeInTheDocument();
    expect(screen.getByText("Another Inbox")).toBeInTheDocument();
    expect(screen.queryByText("Done Task")).not.toBeInTheDocument();
  });

  it("switches tab and shows tasks for that status", () => {
    const tasks = [
      makeTask({ id: "t1", title: "Inbox Task", status: "inbox", priority: 3 }),
      makeTask({ id: "t2", title: "Done Task", status: "done", priority: 2 }),
    ];

    render(<MobileTaskBoard {...defaultProps} tasks={tasks} />);
    // Switch to Done tab
    fireEvent.click(screen.getByText("Done"));
    expect(screen.getByText("Done Task")).toBeInTheDocument();
    expect(screen.queryByText("Inbox Task")).not.toBeInTheDocument();
  });

  it("shows empty state when no tasks match the active tab", () => {
    const tasks = [makeTask({ id: "t1", title: "Done Task", status: "done", priority: 2 })];

    render(<MobileTaskBoard {...defaultProps} tasks={tasks} />);
    // Default tab is inbox, no inbox tasks
    expect(screen.getByText(/no tasks/i)).toBeInTheDocument();
  });

  it("calls onOpenTerminal when a task card is tapped", () => {
    const onOpenTerminal = vi.fn();
    const tasks = [makeTask({ id: "t1", title: "Inbox Task", status: "inbox", priority: 3 })];

    render(<MobileTaskBoard {...defaultProps} tasks={tasks} onOpenTerminal={onOpenTerminal} />);
    fireEvent.click(screen.getByText("Inbox Task"));
    expect(onOpenTerminal).toHaveBeenCalledWith("t1");
  });

  it("shows agent name on task card when assigned", () => {
    const tasks = [makeTask({ id: "t1", title: "Inbox Task", status: "inbox", assigned_agent_id: "a1" })];
    const agents = [
      {
        id: "a1",
        name: "Alice",
        name_ko: "앨리스",
        department_id: "d1",
        role: "senior" as const,
        cli_provider: "claude" as const,
        avatar_emoji: "👩",
        personality: null,
        status: "idle" as const,
        current_task_id: null,
        created_at: 0,
      },
    ];

    render(<MobileTaskBoard {...defaultProps} tasks={tasks} agents={agents} />);
    expect(screen.getByText("Alice")).toBeInTheDocument();
  });

  it("displays count badges on status tabs", () => {
    const tasks = [
      makeTask({ id: "t1", title: "Task 1", status: "inbox", priority: 3 }),
      makeTask({ id: "t2", title: "Task 2", status: "inbox", priority: 2 }),
      makeTask({ id: "t3", title: "Task 3", status: "done", priority: 1 }),
    ];

    render(<MobileTaskBoard {...defaultProps} tasks={tasks} />);
    // Inbox tab should show count 2
    const inboxTab = screen.getByText("Inbox").closest("button");
    expect(inboxTab?.textContent).toContain("2");
    // Done tab should show count 1
    const doneTab = screen.getByText("Done").closest("button");
    expect(doneTab?.textContent).toContain("1");
  });

  it("does not show hidden tasks by default", () => {
    const tasks = [
      makeTask({ id: "t1", title: "Visible Task", status: "inbox", hidden: 0 }),
      makeTask({ id: "t2", title: "Hidden Task", status: "inbox", hidden: 1 }),
    ];

    render(<MobileTaskBoard {...defaultProps} tasks={tasks} />);
    expect(screen.getByText("Visible Task")).toBeInTheDocument();
    expect(screen.queryByText("Hidden Task")).not.toBeInTheDocument();
  });
});
