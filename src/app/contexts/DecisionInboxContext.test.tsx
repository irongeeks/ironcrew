import { describe, expect, it } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import type { DecisionInboxItem } from "../../components/chat/decision-inbox";
import { DecisionInboxProvider, useDecisionInbox } from "./DecisionInboxContext";

const sampleItem: DecisionInboxItem = {
  id: "decision-1",
  kind: "agent_request",
  agentId: "agent-1",
  agentName: "Alice",
  agentNameKo: "앨리스",
  agentAvatar: null,
  requestContent: "Approve PR?",
  createdAt: 1_700_000_000_000,
  taskId: "task-1",
  options: [
    { number: 1, label: "Approve", action: "approve" },
    { number: 2, label: "Reject", action: "reject" },
  ],
};

function Probe(): ReactNode {
  const ctx = useDecisionInbox();
  return (
    <div>
      <span data-testid="show">{ctx.showDecisionInbox ? "open" : "closed"}</span>
      <span data-testid="loading">{ctx.decisionInboxLoading ? "1" : "0"}</span>
      <span data-testid="count">{ctx.decisionInboxItems.length}</span>
      <span data-testid="busy">{ctx.decisionReplyBusyKey ?? "(none)"}</span>
      <button data-testid="open" onClick={() => ctx.setShowDecisionInbox(true)} />
      <button data-testid="close" onClick={() => ctx.setShowDecisionInbox(false)} />
      <button data-testid="setLoading" onClick={() => ctx.setDecisionInboxLoading(true)} />
      <button data-testid="addItem" onClick={() => ctx.setDecisionInboxItems([sampleItem])} />
      <button data-testid="setBusy" onClick={() => ctx.setDecisionReplyBusyKey("decision-1:1")} />
    </div>
  );
}

describe("DecisionInboxContext", () => {
  it("provides initial closed/empty state", () => {
    render(
      <DecisionInboxProvider>
        <Probe />
      </DecisionInboxProvider>,
    );
    expect(screen.getByTestId("show").textContent).toBe("closed");
    expect(screen.getByTestId("loading").textContent).toBe("0");
    expect(screen.getByTestId("count").textContent).toBe("0");
    expect(screen.getByTestId("busy").textContent).toBe("(none)");
  });

  it("opens and closes the inbox via setShowDecisionInbox", async () => {
    const user = userEvent.setup();
    render(
      <DecisionInboxProvider>
        <Probe />
      </DecisionInboxProvider>,
    );
    await user.click(screen.getByTestId("open"));
    expect(screen.getByTestId("show").textContent).toBe("open");
    await user.click(screen.getByTestId("close"));
    expect(screen.getByTestId("show").textContent).toBe("closed");
  });

  it("manages loading flag, items, and busy key", async () => {
    render(
      <DecisionInboxProvider>
        <Probe />
      </DecisionInboxProvider>,
    );
    await act(async () => {
      screen.getByTestId("setLoading").click();
    });
    expect(screen.getByTestId("loading").textContent).toBe("1");
    await act(async () => {
      screen.getByTestId("addItem").click();
    });
    expect(screen.getByTestId("count").textContent).toBe("1");
    await act(async () => {
      screen.getByTestId("setBusy").click();
    });
    expect(screen.getByTestId("busy").textContent).toBe("decision-1:1");
  });

  it("throws when used outside provider", () => {
    const original = console.error;
    console.error = () => {};
    try {
      expect(() => render(<Probe />)).toThrow();
    } finally {
      console.error = original;
    }
  });
});
