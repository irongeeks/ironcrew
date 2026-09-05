import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { request } from "../api/core";
import type { ObjectiveSnapshot } from "../shared/objective-evaluations";
import { ObjectiveEvaluationsPanel } from "./ObjectiveEvaluationsPanel";
vi.mock("../api/core", () => ({ request: vi.fn() }));
const mocked = vi.mocked(request);
const empty = (): ObjectiveSnapshot => ({
  rubrics: [],
  measurements: [],
  runs: [],
  comparisons: [],
  canEdit: true,
  canMeasure: true,
});
let state: ObjectiveSnapshot;
beforeEach(() => {
  state = empty();
  mocked.mockReset();
  mocked.mockImplementation(async () => structuredClone(state));
});
describe("objective evaluations panel", () => {
  it("keeps exact accessible select names independent of persisted run and rubric option text", async () => {
    state.rubrics = [
      {
        id: "rubric-real",
        key: "quality",
        version: 1,
        title: "Gespeicherte Rubrik",
        reason: "Nachweise vorab prüfen.",
        cases: [],
        hash: "hash",
        createdAt: 1,
        createdBy: "ceo",
      },
    ];
    state.runs = [
      {
        id: "run-real",
        taskId: "task-real",
        taskTitle: "Interner Bericht",
        agentId: "agent-real",
        agentName: "Forge",
        runtimeType: "mock",
        model: null,
        status: "completed",
        inputTokens: 12,
        outputTokens: 8,
        costMicros: 0,
      },
    ];
    render(<ObjectiveEvaluationsPanel />);
    const runSelect = await screen.findByRole("combobox", { name: "Abgeschlossener Run" });
    const rubricSelect = screen.getByRole("combobox", { name: "Rubrikversion" });
    expect((runSelect as HTMLSelectElement).labels?.[0].textContent).toBe("Abgeschlossener Run");
    expect((rubricSelect as HTMLSelectElement).labels?.[0].textContent).toBe("Rubrikversion");
    fireEvent.change(runSelect, { target: { value: "run-real" } });
    fireEvent.change(rubricSelect, { target: { value: "rubric-real" } });
    expect(runSelect).toHaveValue("run-real");
    expect(screen.getByRole("button", { name: "Run auswerten" })).toBeEnabled();
  });
  it("shows genuine empty states without fabricated scores", async () => {
    render(<ObjectiveEvaluationsPanel />);
    await screen.findByText(/Noch keine gemessenen Ergebnisse/);
    expect(screen.getByText(/Noch kein abgeschlossener Run/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run auswerten" })).toBeDisabled();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getByText(/getrennt von den 1–5 Sternen/)).toBeInTheDocument();
  });
  it("saves explicit versioned predicates and preserves a draft after conflict", async () => {
    render(<ObjectiveEvaluationsPanel />);
    await screen.findByRole("form", { name: "Rubrik bearbeiten" });
    fireEvent.change(screen.getByLabelText("Rubrikkennung"), { target: { value: "report-quality" } });
    fireEvent.change(screen.getByLabelText("Titel"), { target: { value: "Bericht prüfen" } });
    fireEvent.change(screen.getByLabelText("Änderungsgrund"), { target: { value: "Quellen im Bericht nachweisen." } });
    fireEvent.change(screen.getByLabelText("Bezeichnung"), { target: { value: "Quelle" } });
    fireEvent.change(screen.getByLabelText("Vergleichstext"), { target: { value: "Quelle" } });
    mocked.mockRejectedValueOnce(new Error("Rubrik wurde inzwischen geändert."));
    fireEvent.submit(screen.getByRole("form", { name: "Rubrik bearbeiten" }));
    await screen.findByRole("alert");
    expect(screen.getByLabelText("Titel")).toHaveValue("Bericht prüfen");
    const call = mocked.mock.calls.find(([, options]) => options?.method === "POST");
    expect(call?.[0]).toBe("/api/crew/evaluations/rubrics");
    expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({
      key: "report-quality",
      baseVersion: 0,
      reason: "Quellen im Bericht nachweisen.",
      cases: [{ id: "case-1", kind: "contains", expected: "Quelle" }],
    });
  });
  it("keeps viewer reads available while disabling all writes", async () => {
    state.canEdit = false;
    state.canMeasure = false;
    render(<ObjectiveEvaluationsPanel />);
    await screen.findByText(/Auswertungen starten können Owner/);
    expect(screen.queryByRole("form")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run auswerten" })).toBeDisabled();
  });
  it("supports bounded JSON predicates and recovers a failed initial load", async () => {
    mocked.mockRejectedValueOnce(new Error("Server nicht erreichbar."));
    render(<ObjectiveEvaluationsPanel />);
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Aktualisieren" }));
    await screen.findByLabelText("Prüfart");
    fireEvent.change(screen.getByLabelText("Prüfart"), { target: { value: "json_field" } });
    expect(screen.getByLabelText("Feldpfad (durch Punkt getrennt)")).toHaveValue("result");
    expect(screen.getByLabelText("Erwarteter Typ")).toHaveValue("string");
    fireEvent.click(screen.getByRole("button", { name: "Prüfung hinzufügen" }));
    await waitFor(() => expect(screen.getAllByLabelText("Bezeichnung")).toHaveLength(2));
  });
});
