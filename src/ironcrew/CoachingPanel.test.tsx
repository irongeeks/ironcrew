import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { request } from "../api/core";
import type { CoachingProposal, CoachingSnapshot } from "../shared/coaching";
import { CoachingPanel } from "./CoachingPanel";
vi.mock("../api/core", () => ({ request: vi.fn() }));
const mocked = vi.mocked(request);
const agents = [
  { id: "agent-a", displayName: "Forge" },
  { id: "agent-b", displayName: "Atlas" },
];
const draft: CoachingProposal = {
  id: "proposal-1",
  agentId: "agent-a",
  title: "Quellen verbessern",
  guidance: "Quellen nennen.",
  skills: [],
  cases: [{ label: "Quelle", kind: "guidance_contains", expected: "Quellen" }],
  baseVersion: 0,
  status: "draft",
  createdAt: 1000,
  createdBy: "owner",
  reviewReason: "",
  reviewedBy: null,
  evaluation: null,
};
const empty = (): CoachingSnapshot => ({ proposals: [], notes: [], versions: [], current: null, skills: [] });
let state: CoachingSnapshot;
beforeEach(() => {
  state = empty();
  mocked.mockReset();
  mocked.mockImplementation(async (url, options) => {
    if (!options?.method || options.method === "GET") return structuredClone(state);
    if (String(url).endsWith("/evaluate")) {
      state.proposals[0] = {
        ...state.proposals[0],
        status: "ready",
        evaluation: {
          id: "eval-1",
          createdAt: 2000,
          passed: true,
          passedCases: 1,
          totalCases: 1,
          checks: [{ ...draft.cases[0], passed: true, observed: "Text vorhanden", evidenceHash: null }],
        },
      };
    }
    if (String(url).endsWith("/review")) {
      const input = JSON.parse(String(options.body));
      state.proposals[0] = {
        ...state.proposals[0],
        status: input.decision === "approve" ? "applied" : "rejected",
        reviewedBy: "owner",
        reviewReason: input.reason,
      };
      if (input.decision === "approve")
        state.current = {
          version: 1,
          guidance: draft.guidance,
          skills: [],
          proposalId: draft.id,
          approvedBy: "owner",
          createdAt: 3000,
        };
    }
    return {};
  });
});
describe("CoachingPanel", () => {
  it("persists exact draft criteria without providing any self-reported evaluation score", async () => {
    render(<CoachingPanel agents={agents} />);
    await screen.findByText(
      "Noch keine Vorschläge. Eine Beobachtung aus dem nächsten Review kann der Ausgangspunkt sein.",
    );
    fireEvent.click(screen.getByText("Guidance-Änderung vorschlagen"));
    fireEvent.change(screen.getByLabelText("Titel"), { target: { value: "Quellen verbessern" } });
    fireEvent.change(screen.getByLabelText("Vollständige neue Coaching-Guidance"), {
      target: { value: "Quellen nennen." },
    });
    fireEvent.change(screen.getByLabelText("Prüfung 1: Bezeichnung"), { target: { value: "Quelle" } });
    fireEvent.change(screen.getByLabelText("Prüfung 1: Erwarteter Text oder Skill"), { target: { value: "Quellen" } });
    await userEvent.click(screen.getByRole("button", { name: "Vorschlag speichern" }));
    const sent = mocked.mock.calls.find(([url]) => url === "/api/crew/coaching/proposals");
    expect(JSON.parse(String(sent?.[1]?.body))).toEqual({
      agentId: "agent-a",
      title: "Quellen verbessern",
      guidance: "Quellen nennen.",
      skills: [],
      cases: [{ label: "Quelle", kind: "guidance_contains", expected: "Quellen" }],
    });
    expect(await screen.findByRole("status")).toHaveTextContent("Vorschlag gespeichert");
  });
  it("keeps apply disabled until server evaluation passes and the owner supplies a reason", async () => {
    state.proposals = [structuredClone(draft)];
    render(<CoachingPanel agents={agents} />);
    await screen.findByText("Quellen verbessern · Entwurf");
    expect(screen.getByRole("button", { name: "Freigeben und übernehmen" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Kriterien auswerten" }));
    await screen.findByText("1 von 1 Kriterien bestanden");
    expect(screen.getByRole("button", { name: "Freigeben und übernehmen" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Begründung für „Quellen verbessern“"), {
      target: { value: "Nachweise und konkrete Formulierung geprüft." },
    });
    await userEvent.click(screen.getByRole("button", { name: "Freigeben und übernehmen" }));
    await screen.findByText("Aktive Guidance · Version 1");
    expect(mocked).toHaveBeenCalledWith("/api/crew/coaching/proposals/proposal-1/review", {
      method: "POST",
      body: JSON.stringify({ decision: "approve", reason: "Nachweise und konkrete Formulierung geprüft." }),
    });
  });
  it("renders viewer history without mutation controls and shows load failures honestly", async () => {
    state.proposals = [structuredClone(draft)];
    const view = render(<CoachingPanel agents={agents} canEdit={false} canReview={false} />);
    await screen.findByText("Quellen verbessern · Entwurf");
    expect(screen.queryByRole("button", { name: "Kriterien auswerten" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Freigeben und übernehmen" })).not.toBeInTheDocument();
    view.unmount();
    mocked.mockRejectedValueOnce(new Error("Verbindung unterbrochen"));
    render(<CoachingPanel agents={agents} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Verbindung unterbrochen");
    expect(screen.getByRole("button", { name: "Erneut laden" })).toBeInTheDocument();
  });
  it("clears unsaved agent-specific notes and draft when switching agents", async () => {
    render(<CoachingPanel agents={agents} />);
    await screen.findByText("Noch keine Beobachtungen gespeichert.");
    fireEvent.change(screen.getByLabelText("Titel der Beobachtung"), { target: { value: "Private note for Forge" } });
    fireEvent.change(screen.getByLabelText("Agent"), { target: { value: "agent-b" } });
    await waitFor(() => expect(mocked).toHaveBeenCalledWith("/api/crew/coaching?agentId=agent-b"));
    expect(screen.getByLabelText("Titel der Beobachtung")).toHaveValue("");
  });
});
