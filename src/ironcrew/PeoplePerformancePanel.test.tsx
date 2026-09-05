import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetApiRuntimeForTests, writeStoredCsrfToken } from "../api/core";
import type { CareerSnapshot, RatingAggregate } from "../shared/career";
import { ROUTING_PROFILE_KEYS, type RoutingSnapshot } from "../shared/routing-profiles";
import { PeoplePerformancePanel, PeopleAgentSummary } from "./PeoplePerformancePanel";

const agents = [
  { id: "ada", displayName: "Ada", departmentId: "engineering", professionalRole: "Softwareentwicklung" },
  { id: "lead", displayName: "Morgan", departmentId: "engineering", professionalRole: "Architektur" },
  { id: "qa", displayName: "Quinn", departmentId: "quality", professionalRole: "quality_assurance" },
  { id: "new", displayName: "Neu", departmentId: "engineering", professionalRole: "Softwareentwicklung" },
];
const departments = [
  { id: "engineering", name: "Engineering" },
  { id: "quality", name: "Qualität" },
];
const aggregate = (key: string): RatingAggregate => ({
  key,
  count: 1,
  mean: 4,
  distribution: { 1: 0, 2: 0, 3: 0, 4: 1, 5: 0 },
  revisions: 1,
  complexity: { simple: 0, normal: 0, complex: 1 },
});
let snapshot: CareerSnapshot;
let routing: RoutingSnapshot;
let writes: Array<{ url: string; body: unknown; options: RequestInit }>;
let reads: string[];
let rejectWrite: boolean;
let filteredResponse: CareerSnapshot | null;
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}
async function mount(canManage = false) {
  const onOpenRouting = vi.fn();
  const view = render(
    <PeoplePerformancePanel
      agents={agents}
      departments={departments}
      canManage={canManage}
      onOpenRouting={onOpenRouting}
    />,
  );
  await screen.findByRole("heading", { name: "Mitarbeiter & Modellprofile" });
  return { ...view, onOpenRouting };
}
beforeEach(() => {
  __resetApiRuntimeForTests();
  sessionStorage.clear();
  writeStoredCsrfToken("people-csrf");
  writes = [];
  reads = [];
  rejectWrite = false;
  filteredResponse = null;
  snapshot = {
    config: {
      revision: 3,
      enabled: true,
      departments: [
        { departmentId: "engineering", enabled: true, leadAgentId: "lead", fallbackReviewerAgentId: "qa" },
        { departmentId: "quality", enabled: false, leadAgentId: null, fallbackReviewerAgentId: null },
      ],
    },
    profiles: agents.map((agent) => ({
      agentId: agent.id,
      level: agent.id === "lead" || agent.id === "qa" ? "lead" : "junior",
      revision: 2,
    })),
    reviews: [
      {
        rubricVersion: 1,
        reviewerRuntimeType: "claude",
        reviewerModel: "review-model",
        reviewerVesselId: "review-vessel",
        id: "review-2",
        taskId: "task-1",
        workRunId: "work-2",
        reviewRunId: "lead-run-2",
        agentId: "ada",
        reviewerAgentId: "lead",
        runtimeType: "codex",
        model: "coding-model",
        vesselId: "local-codex",
        revision: 2,
        difficulty: "complex",
        score: 4,
        rationale: "Abnahmekriterien erfüllt, Randfall dokumentiert.",
        rubricDimensions: { correctness: 4, completeness: 5, quality: 4 },
        evidence: ["artifact:result-2"],
        createdAt: 1760000000000,
        isCurrent: true,
      },
      {
        rubricVersion: 1,
        reviewerRuntimeType: "claude",
        reviewerModel: "review-model",
        reviewerVesselId: "review-vessel",
        id: "review-1",
        taskId: "task-1",
        workRunId: "work-1",
        reviewRunId: "lead-run-1",
        agentId: "ada",
        reviewerAgentId: "lead",
        runtimeType: "codex",
        model: "coding-model",
        vesselId: "local-codex",
        revision: 1,
        difficulty: "complex",
        score: 2,
        rationale: "Früheres Ergebnis war unvollständig.",
        rubricDimensions: { correctness: 2, completeness: 2, quality: 3 },
        evidence: [],
        createdAt: 1750000000000,
        isCurrent: false,
      },
    ],
    aggregates: { agents: [aggregate("ada")], models: [aggregate("coding-model")] },
    pendingChanges: [],
    workflows: [],
  };
  routing = {
    revision: 1,
    config: {
      version: 1,
      profiles: ROUTING_PROFILE_KEYS.map((key) => ({
        key,
        label: key === "coding" ? "Entwicklung" : key,
        primary: null,
        fallbacks: [],
        allowFallback: false,
        allowedSensitivity: ["internal"],
        requiredCapabilities: [],
      })),
    },
    bindings: [{ agentId: "ada", profileKey: "coding" }],
    vessels: [],
    history: [],
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, options?: RequestInit) => {
      if (!options?.method || options.method === "GET") {
        reads.push(input);
        if (input === "/api/crew/routing") return json(routing);
        if (input.startsWith("/api/crew/people"))
          return json(input.includes("?") && filteredResponse ? filteredResponse : snapshot);
        throw new Error(`Unexpected GET ${input}`);
      }
      const body: unknown = JSON.parse(String(options.body));
      writes.push({ url: input, body, options });
      const headers = new Headers(options.headers);
      if (headers.get("Content-Type") !== "application/json") return json({ error: "json_required" }, 415);
      if (rejectWrite)
        return json({ error: "revision_conflict", message: "Zwischenzeitlich geändert. Bitte erneut laden." }, 409);
      if (input.endsWith("/config")) {
        const value = body as typeof snapshot.config & { baseRevision: number };
        snapshot = {
          ...snapshot,
          config: { enabled: value.enabled, departments: value.departments, revision: value.baseRevision + 1 },
        };
        return json(snapshot.config);
      }
      if (input.endsWith("/level")) {
        const value = body as { level: "senior"; baseRevision: number };
        snapshot.pendingChanges.push({
          id: "change-1",
          agentId: "ada",
          level: value.level,
          baseRevision: value.baseRevision,
          approvalId: "approval-1",
          status: "pending",
        });
        return json({ change: snapshot.pendingChanges[0], approval: { id: "approval-1" } });
      }
      throw new Error(`Unexpected mutation ${input}`);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("PeoplePerformancePanel", () => {
  it("shows actual reviewed context and revisions without counting historical scores or inventing unrated metrics", async () => {
    await mount();
    expect(screen.getByText(/keine objektive Modellgüte/)).toBeInTheDocument();
    const tables = screen.getAllByRole("table");
    const roster = tables[0];
    expect(within(roster).getByText("Entwicklung (coding)")).toBeInTheDocument();
    expect(within(roster).getByText("4 / 5 · 1 Bewertungen")).toBeInTheDocument();
    expect(within(roster).getAllByText("– Unbewertet")).toHaveLength(3);
    const employeeStats = tables[1];
    expect(within(employeeStats).getByRole("meter", { name: "4 Sterne" })).toHaveAttribute("value", "1");
    expect(screen.getByText(/Historisch – nicht im Durchschnitt/)).toBeInTheDocument();
    expect(screen.getByText("work-2")).toBeInTheDocument();
    expect(screen.getByText("lead-run-2")).toBeInTheDocument();
    expect(screen.getByText("artifact:result-2")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /bewerten|Sterne vergeben/i })).not.toBeInTheDocument();
    expect(writes).toHaveLength(0);
  });

  it("shows canonical level, profile and task evidence directly in the employee drilldown", async () => {
    const open = vi.fn();
    render(<PeopleAgentSummary agentId="ada" agents={agents} onOpenPeople={open} />);
    await screen.findByText("Junior");
    expect(screen.getByText("4 / 5 · 1 Bewertungen")).toBeInTheDocument();
    expect(screen.getByText("Entwicklung (coding)")).toBeInTheDocument();
    expect(screen.getByText("work-2")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Teamsteuerung und gesamten Bewertungsverlauf öffnen" }));
    expect(open).toHaveBeenCalledOnce();
    expect(writes).toHaveLength(0);
  });

  it("keeps read-only users out of owner forms and opens the existing routing UI", async () => {
    const { onOpenRouting } = await mount();
    expect(screen.queryByRole("button", { name: "Abteilungssteuerung speichern" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Leveländerung zur Freigabe anfragen" })).not.toBeInTheDocument();
    expect(screen.getByText(/Lead: Morgan · Ersatzreviewer: Quinn/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Bestehende Modellprofile und Zuordnungen öffnen" }));
    expect(onOpenRouting).toHaveBeenCalledOnce();
    expect(writes).toHaveLength(0);
  });

  it("sends versioned department configuration over the actual JSON and CSRF transport", async () => {
    await mount(true);
    const enabled = screen.getByLabelText("Lead-Delegation und Aufgabenbewertung aktivieren");
    fireEvent.click(enabled);
    const leadSelect = screen.getAllByLabelText("Abteilungslead")[0];
    expect(within(leadSelect).queryByRole("option", { name: "Ada" })).not.toBeInTheDocument();
    expect(within(leadSelect).queryByRole("option", { name: "Quinn" })).not.toBeInTheDocument();
    const fallback = screen.getAllByLabelText("Unabhängiger Ersatzreviewer")[0];
    expect(within(fallback).queryByRole("option", { name: "Morgan" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Abteilungssteuerung speichern" }));
    await screen.findByText("Abteilungssteuerung gespeichert.");
    expect(writes).toHaveLength(1);
    expect(writes[0].body).toEqual({ baseRevision: 3, enabled: false, departments: snapshot.config.departments });
    expect(writes[0].options.method).toBe("PUT");
    expect(new Headers(writes[0].options.headers).get("x-csrf-token")).toBe("people-csrf");
    expect(writes[0].options.credentials).toBe("same-origin");
  });

  it("requests a level approval with rationale and leaves the existing junior level active", async () => {
    await mount(true);
    fireEvent.change(screen.getByLabelText("Neues Level"), { target: { value: "senior" } });
    fireEvent.change(screen.getByLabelText("Begründung"), {
      target: { value: "  Nachvollziehbare Erfahrung im Projekt.  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Leveländerung zur Freigabe anfragen" }));
    await screen.findByText(/Leveländerung zur Freigabe angefragt/);
    expect(writes[0].url).toBe("/api/crew/people/agents/ada/level");
    expect(writes[0].body).toEqual({
      baseRevision: 2,
      level: "senior",
      reason: "Nachvollziehbare Erfahrung im Projekt.",
    });
    expect(screen.getByText("approval-1")).toBeInTheDocument();
    expect(screen.getByText(/Aktuell: Junior/)).toBeInTheDocument();
  });

  it("applies identical server filters to history and aggregates and shows an honest empty result", async () => {
    await mount();
    filteredResponse = { ...snapshot, reviews: [], aggregates: { agents: [], models: [] } };
    fireEvent.change(screen.getByLabelText("Schwierigkeit"), { target: { value: "simple" } });
    fireEvent.change(screen.getByLabelText("Modellname (exakt)"), { target: { value: "other/model" } });
    fireEvent.change(screen.getByLabelText("Von (lokale Zeit)"), { target: { value: "2026-01-01T10:00" } });
    expect(reads.filter((url) => url.includes("difficulty"))).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Filter anwenden" }));
    await screen.findByText(/Noch keine Bewertungen. Ein abgeschlossener/);
    const query = new URL(reads.find((url) => url.includes("difficulty"))!, "http://fixture.invalid").searchParams;
    expect(query.get("difficulty")).toBe("simple");
    expect(query.get("model")).toBe("other/model");
    expect(query.get("from")).toBe(String(new Date("2026-01-01T10:00").getTime()));
    expect(screen.queryByText("work-2")).not.toBeInTheDocument();
    expect(screen.getAllByText("– Noch keine Bewertungen für diese Auswahl.")).toHaveLength(2);
  });

  it("shows blocked or missing lead reviews explicitly without fabricating a score", async () => {
    snapshot.reviews = [];
    snapshot.aggregates = { agents: [], models: [] };
    snapshot.workflows = [
      {
        id: "blocked-review",
        companyId: "company",
        purpose: "review",
        taskId: "task-owner",
        workRunId: "work-real",
        internalTaskId: null,
        leadAgentId: "lead",
        reviewerAgentId: null,
        revision: 1,
        status: "owner_required",
        difficulty: "normal",
        runId: null,
        assignedAgentId: "lead",
        rationale: "Unabhängiger QA-Reviewer fehlt.",
      },
    ];
    await mount();
    expect(screen.getByText("Lead-Review · Ownerentscheidung erforderlich")).toBeInTheDocument();
    expect(screen.getByText("Unabhängiger QA-Reviewer fehlt.")).toBeInTheDocument();
    expect(screen.getByText(/Noch keine abgeschlossene Bewertung für diesen Schritt/)).toBeInTheDocument();
    expect(screen.queryByText(/4 \/ 5/)).not.toBeInTheDocument();
  });

  it("surfaces server conflicts without announcing a saved configuration", async () => {
    await mount(true);
    rejectWrite = true;
    fireEvent.click(screen.getByRole("button", { name: "Abteilungssteuerung speichern" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("alert")).toHaveTextContent("Zwischenzeitlich geändert");
    expect(screen.queryByText("Abteilungssteuerung gespeichert.")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Abteilungssteuerung speichern" })).toBeEnabled());
  });
});
