import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MobileBottomTabBar } from "./MobileBottomTabBar";

describe("MobileBottomTabBar", () => {
  const defaultProps = {
    activeView: "office" as const,
    onChangeView: vi.fn(),
  };

  it("renders 5 tab buttons", () => {
    render(<MobileBottomTabBar {...defaultProps} />);
    const buttons = screen.getAllByRole("button");
    expect(buttons.length).toBe(5);
  });

  it("renders Office, Tasks, CEO Chat, Ops, More tabs", () => {
    render(<MobileBottomTabBar {...defaultProps} />);
    expect(screen.getByText("Office")).toBeInTheDocument();
    expect(screen.getByText("Tasks")).toBeInTheDocument();
    expect(screen.getByText("CEO Chat")).toBeInTheDocument();
    expect(screen.getByText("Ops")).toBeInTheDocument();
    expect(screen.getByText("More")).toBeInTheDocument();
  });

  it("highlights the active tab", () => {
    render(<MobileBottomTabBar {...defaultProps} activeView="tasks" />);
    const tasksBtn = screen.getByText("Tasks").closest("button")!;
    expect(tasksBtn.className).toContain("text-retro-green");
  });

  it("calls onChangeView when a direct tab is tapped", () => {
    const onChangeView = vi.fn();
    render(<MobileBottomTabBar {...defaultProps} onChangeView={onChangeView} />);
    fireEvent.click(screen.getByText("Tasks"));
    expect(onChangeView).toHaveBeenCalledWith("tasks");
  });

  it("opens and marks the canonical CEO chat on mobile", () => {
    const onChangeView = vi.fn();
    render(<MobileBottomTabBar {...defaultProps} activeView="command" onChangeView={onChangeView} />);
    const chat = screen.getByRole("button", { name: "CEO Chat" });
    expect(chat).toHaveAttribute("aria-current", "page");
    fireEvent.click(chat);
    expect(onChangeView).toHaveBeenCalledWith("command");
  });

  it("opens More sheet when More is tapped", () => {
    render(<MobileBottomTabBar {...defaultProps} />);
    fireEvent.click(screen.getByText("More"));
    expect(screen.getByText("Roster")).toBeInTheDocument();
    expect(screen.getByText("Library")).toBeInTheDocument();
    expect(screen.getByText("Projects")).toBeInTheDocument();
    expect(screen.getByText("Schedules")).toBeInTheDocument();
    expect(screen.getByText("Settings")).toBeInTheDocument();
  });

  it("calls onChangeView and closes sheet when a More item is tapped", () => {
    const onChangeView = vi.fn();
    render(<MobileBottomTabBar {...defaultProps} onChangeView={onChangeView} />);
    fireEvent.click(screen.getByText("More"));
    fireEvent.click(screen.getByText("Settings"));
    expect(onChangeView).toHaveBeenCalledWith("settings");
    expect(screen.queryByText("Roster")).not.toBeInTheDocument();
  });

  it("all tab buttons have minimum 44px touch target", () => {
    render(<MobileBottomTabBar {...defaultProps} />);
    const buttons = screen.getAllByRole("button");
    buttons.forEach((btn) => {
      expect(btn.className).toContain("min-h-[56px]");
    });
  });

  it("renders a pack selector in the More sheet when pack props are supplied", () => {
    const onChangeOfficeWorkflowPack = vi.fn();
    render(
      <MobileBottomTabBar
        {...defaultProps}
        officePackKey={"development" as never}
        officePackLabel="Workflow Pack"
        officePackOptions={[
          { key: "development" as never, label: "Development", slug: "DEV" },
          { key: "report" as never, label: "Report", slug: "REP" },
        ]}
        onChangeOfficeWorkflowPack={onChangeOfficeWorkflowPack}
      />,
    );
    fireEvent.click(screen.getByText("More"));
    const select = screen.getByLabelText("Workflow Pack") as HTMLSelectElement;
    expect(select).toBeInTheDocument();
    expect(select.value).toBe("development");
    fireEvent.change(select, { target: { value: "report" } });
    expect(onChangeOfficeWorkflowPack).toHaveBeenCalledWith("report");
  });

  it("omits the pack selector when pack props are not supplied", () => {
    render(<MobileBottomTabBar {...defaultProps} />);
    fireEvent.click(screen.getByText("More"));
    expect(screen.queryByLabelText("Workflow Pack")).not.toBeInTheDocument();
  });
});
