import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { request } from "../api/core";
import type { ProjectPlanRecord } from "../shared/project-planning";
import { ProjectPlanningPanel } from "./ProjectPlanningPanel";
vi.mock("../api/core", () => ({ request: vi.fn() }));
const mock = vi.mocked(request);
const plan: ProjectPlanRecord = {
  id: "plan-1",
  company_id: "company-1",
  project_id: "project-1",
  task_id: "task-1",
  run_id: "run-1",
  status: "review",
  error: null,
  reviewed_by: null,
  created_at: 1000,
  updated_at: 2000,
  plan: {
    version: 1,
    goal: "Dokumentierte Demo bereitstellen",
    scope: ["Lokale Demo"],
    nonGoals: ["Kein Produktionsdeploy"],
    assumptions: ["Nur Testdaten"],
    risks: ["Zugang fehlt"],
    deliverables: ["Quellcode und Testbericht"],
    approvalPoints: ["Produktionsfreigabe separat"],
    budgetMicros: 2_500_000,
    tasks: [
      {
        key: "build",
        title: "Demo bauen",
        description: "Lokale Oberfläche implementieren",
        agentKey: "cto",
        dependsOn: [],
        acceptanceCriteria: ["Build besteht"],
        riskLevel: "low",
      },
      {
        key: "qa",
        title: "Demo prüfen",
        description: "Abnahme dokumentieren",
        agentKey: "qa",
        dependsOn: ["build"],
        acceptanceCriteria: ["Testbericht gespeichert"],
        riskLevel: "medium",
      },
    ],
  },
};
let current: ProjectPlanRecord;
beforeEach(() => {
  current = structuredClone(plan);
  mock.mockReset();
  mock.mockImplementation(async (_url, options) => {
    if (options?.method === "POST") {
      current = { ...current, status: JSON.parse(String(options.body)).decision, reviewed_by: "owner" };
      return { plan: current };
    }
    return { plans: [current] };
  });
});
describe("ProjectPlanningPanel", () => {
  it("shows complete reviewable plan and sends owner approval only on explicit action", async () => {
    const onChanged = vi.fn();
    render(<ProjectPlanningPanel onChanged={onChanged} />);
    await screen.findByText("Dokumentierte Demo bereitstellen");
    for (const value of [
      "Lokale Demo",
      "Kein Produktionsdeploy",
      "Nur Testdaten",
      "Zugang fehlt",
      "Quellcode und Testbericht",
      "Produktionsfreigabe separat",
      "Demo bauen",
      "Demo prüfen",
      "Build besteht",
      "Testbericht gespeichert",
    ])
      expect(screen.getByText(value)).toBeInTheDocument();
    expect(screen.getByText(/2,50\s*\$/)).toBeInTheDocument();
    expect(mock.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: "Plan freigeben" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
    expect(mock).toHaveBeenCalledWith("/api/crew/project-plans/task-1/review", {
      method: "POST",
      body: JSON.stringify({ decision: "approved" }),
    });
    expect(screen.queryByRole("button", { name: "Plan freigeben" })).not.toBeInTheDocument();
  });
  it("allows rejection without claiming execution and hides owner actions from reviewers", async () => {
    const view = render(<ProjectPlanningPanel canReview={false} />);
    await screen.findByText("Die Entscheidung benötigt die Owner-Rolle.");
    expect(screen.queryByRole("button", { name: "Plan freigeben" })).not.toBeInTheDocument();
    view.unmount();
    render(<ProjectPlanningPanel />);
    await screen.findByText("Dokumentierte Demo bereitstellen");
    await userEvent.click(screen.getByRole("button", { name: "Plan ablehnen" }));
    expect(
      await screen.findByText("Plan abgelehnt. Die geplanten Teilaufgaben werden nicht ausgeführt."),
    ).toBeInTheDocument();
    expect(mock).toHaveBeenCalledWith("/api/crew/project-plans/task-1/review", {
      method: "POST",
      body: JSON.stringify({ decision: "rejected" }),
    });
  });
  it("keeps review pending after a server failure instead of claiming approval", async () => {
    mock.mockImplementation(async (_url, options) => {
      if (options?.method === "POST") throw new Error("Plan wurde inzwischen geändert");
      return { plans: [current] };
    });
    render(<ProjectPlanningPanel />);
    await screen.findByText("Dokumentierte Demo bereitstellen");
    await userEvent.click(screen.getByRole("button", { name: "Plan freigeben" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Plan wurde inzwischen geändert");
    expect(screen.getByRole("button", { name: "Plan freigeben" })).toBeEnabled();
    expect(screen.queryByText(/Die genehmigten Aufgaben/)).not.toBeInTheDocument();
  });
  it("renders empty and invalid planning states without approval controls", async () => {
    mock.mockResolvedValueOnce({ plans: [] });
    const view = render(<ProjectPlanningPanel />);
    await screen.findByText(/Noch keine Projektpläne/);
    view.unmount();
    mock.mockResolvedValue({
      plans: [{ ...current, status: "failed", plan: null, error: "Abhängigkeiten sind zyklisch." }],
    });
    render(<ProjectPlanningPanel />);
    await screen.findByText("Abhängigkeiten sind zyklisch.");
    expect(screen.queryByRole("button", { name: "Plan freigeben" })).not.toBeInTheDocument();
  });
});
