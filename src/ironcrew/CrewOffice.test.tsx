import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CrewOffice, currentOfficeTask } from "./CrewOffice";
import type { Agent, Task } from "./types";

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-engineer",
    key: "engineer",
    displayName: "Forge",
    professionalRole: "engineering",
    roleSummary: "Engineering",
    seniority: "lead",
    departmentId: "engineering",
    runtimeProfile: "coding",
    runtimeProvider: "codex",
    isExecutiveAssistant: false,
    persona: {
      display_name: "Forge",
      accent: "cyan",
      traits: [],
      forbidden_traits: [],
      portrait: null,
      full_body: null,
      model_3d: null,
    },
    policy: {
      may_delegate: false,
      may_create_tasks: true,
      may_approve: false,
      max_risk_level: "low",
      allowed_tools: [],
      requires_approval_for: [],
    },
    status: "idle",
    ...overrides,
  };
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-live",
    title: "Backup prüfen",
    description: "",
    status: "running",
    priority: "normal",
    risk_level: "low",
    sensitive: 0,
    assigned_agent_id: "agent-engineer",
    result_summary: null,
    review_notes: null,
    correlation_id: "correlation-live",
    created_at: 1,
    updated_at: 2,
    ...overrides,
  };
}

function props() {
  return {
    agents: [agent({ status: "working" })],
    tasks: [task()],
    departments: [{ id: "engineering", key: "engineering", name: "Technik", description: "" }],
    onSelectAgent: vi.fn(),
    onSelectTask: vi.fn(),
  };
}

describe("CrewOffice canonical office", () => {
  it("opens the same agent and task records used by the dashboard with keyboard controls", async () => {
    const input = props();
    const user = userEvent.setup();
    render(<CrewOffice {...input} />);
    const person = screen.getByRole("button", { name: /Forge – Arbeitet/ });
    person.focus();
    await user.keyboard("{Enter}");
    expect(input.onSelectAgent).toHaveBeenCalledWith(input.agents[0]);
    await user.click(screen.getByRole("button", { name: "Aufgabe von Forge: Backup prüfen" }));
    expect(input.onSelectTask).toHaveBeenCalledWith(input.tasks[0]);
  });

  it("moves an existing figure from the desk to the meeting zone on a backend status change", () => {
    const input = props();
    const { rerender } = render(<CrewOffice {...input} />);
    const before = screen.getByTestId("office-person-agent-engineer").style.transform;
    rerender(<CrewOffice {...input} agents={[agent({ status: "in_meeting" })]} />);
    expect(screen.getByTestId("office-person-agent-engineer").style.transform).not.toBe(before);
    expect(screen.getByRole("button", { name: /Forge – Im Meeting/ })).toBeInTheDocument();
    rerender(
      <CrewOffice {...input} agents={[agent({ status: "rate_limited" })]} tasks={[task({ status: "waiting" })]} />,
    );
    expect(screen.getByTestId("office-person-agent-engineer")).toHaveAttribute("data-status", "rate_limited");
    expect(screen.getByRole("button", { name: /Forge – Rate-Limit – Wartet:/ })).toBeInTheDocument();
  });

  it("keeps blocking evidence and accessible task navigation in the list fallback", () => {
    const input = { ...props(), tasks: [task({ status: "blocked" })] };
    render(<CrewOffice {...input} />);
    expect(screen.getByTestId("office-person-agent-engineer")).toHaveAttribute("data-blocked", "true");
    fireEvent.click(screen.getByRole("button", { name: "Liste" }));
    expect(screen.getByRole("list", { name: "Crew und aktuelle Aufgaben" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Blockiert: Backup prüfen" }));
    expect(input.onSelectTask).toHaveBeenCalledWith(input.tasks[0]);
  });

  it("filters departments without changing desk assignments or fabricating agents", () => {
    const input = props();
    render(
      <CrewOffice
        {...input}
        departments={[...input.departments, { id: "finance", key: "finance", name: "Finanzen", description: "" }]}
      />,
    );
    const before = screen.getByTestId("office-person-agent-engineer").style.transform;
    fireEvent.change(screen.getByRole("combobox", { name: "Büro nach Abteilung filtern" }), {
      target: { value: "finance" },
    });
    expect(screen.getByTestId("office-person-agent-engineer").style.transform).toBe(before);
    expect(screen.getByRole("button", { name: /Forge – Arbeitet/ })).toBeDisabled();
    expect(screen.getByText("Dieser Abteilung ist noch kein Agent zugeordnet.")).toBeInTheDocument();
  });

  it("shows an honest empty office", () => {
    render(<CrewOffice {...props()} agents={[]} tasks={[]} />);
    expect(screen.getByText(/Noch keine Crew vorhanden/)).toBeInTheDocument();
    expect(screen.queryByTestId("office-person-agent-engineer")).not.toBeInTheDocument();
  });

  it("fits the complete office to the available viewport and allows readable full-size inspection", () => {
    let resize: (width: number) => void = () => {};
    const disconnect = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: (entries: { contentRect: { width: number } }[]) => void) {
          resize = (width) => callback([{ contentRect: { width } }]);
        }
        observe() {}
        disconnect = disconnect;
      },
    );
    try {
      const { container, unmount } = render(<CrewOffice {...props()} />);
      act(() => resize(560));
      expect(container.querySelector(".crew-office-floor")).toHaveStyle({ transform: "scale(0.5)" });
      expect(container.querySelector(".crew-office-canvas-space")).toHaveStyle({ width: "560px" });
      fireEvent.click(screen.getByRole("button", { name: "100 %" }));
      expect(container.querySelector(".crew-office-floor")).toHaveStyle({ transform: "scale(1)" });
      unmount();
      expect(disconnect).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each(["in_meeting", "waiting_for_approval"] as const)(
    "keeps a full crew in %s inside separate, non-overlapping rooms",
    (status) => {
      const agents = Array.from({ length: 14 }, (_, index) =>
        agent({ id: `agent-${index}`, key: `key-${index}`, status }),
      );
      const { container } = render(<CrewOffice {...props()} agents={agents} tasks={[]} />);
      const rooms = container.querySelectorAll<SVGRectElement>('svg > rect[x="822"]');
      const meetingBottom = Number(rooms[0].getAttribute("y")) + Number(rooms[0].getAttribute("height"));
      expect(meetingBottom).toBeLessThan(Number(rooms[1].getAttribute("y")));
      const floor = container.querySelector<HTMLElement>(".crew-office-floor")!;
      const positions = Array.from(container.querySelectorAll<HTMLElement>(".crew-office-occupant")).map(
        (person) => person.style.transform,
      );
      expect(new Set(positions).size).toBe(14);
      for (const position of positions) {
        const y = Number(position.match(/,\s*([\d.]+)px/)![1]);
        expect(y + 140).toBeLessThan(Number.parseFloat(floor.style.height) - 68);
      }
    },
  );

  it("selects current running work ahead of older failures and excludes completed work", () => {
    const live = task();
    expect(
      currentOfficeTask("agent-engineer", [
        task({ id: "failed", status: "failed", updated_at: 9 }),
        task({ id: "queued", status: "assigned", updated_at: 8 }),
        live,
      ]),
    ).toBe(live);
    expect(currentOfficeTask("agent-engineer", [task({ status: "done" })])).toBeUndefined();
    expect(currentOfficeTask("someone-else", [live])).toBeUndefined();
  });
});
