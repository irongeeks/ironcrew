import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SandboxAccessPanel, type SandboxAccessData } from "./SandboxAccessPanel";
const tasks = [{ id: "task1", title: "Migration prüfen", project_id: "project1" }];
function props(data: SandboxAccessData = { grants: [], requests: [] }) {
  return { tasks, load: vi.fn(async () => data), request: vi.fn(async () => ({})), revoke: vi.fn(async () => ({})) };
}
describe("SandboxAccessPanel", () => {
  it("submits a concrete request and keeps owner approval distinct from granting access", async () => {
    const client = props();
    const user = userEvent.setup();
    render(<SandboxAccessPanel {...client} />);
    await screen.findByText("Noch keine Sandbox-Ausnahme genehmigt.");
    await user.selectOptions(screen.getByLabelText("Aufgabe"), "task1");
    await user.type(screen.getByLabelText("Begründung"), "Einmaliger isolierter Migrationstest");
    await user.click(screen.getByRole("button", { name: "Ausnahme anfragen" }));
    await waitFor(() =>
      expect(client.request).toHaveBeenCalledWith({
        taskId: "task1",
        provider: "codex",
        durationMs: 900000,
        reason: "Einmaliger isolierter Migrationstest",
      }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent("Freigabe-Inbox");
  });
  it("revokes the exact existing grant and exposes refusal from the server", async () => {
    const client = props({
      requests: [],
      grants: [
        {
          id: "grant1",
          task_id: "task1",
          workspace_path: "/work/project",
          providers_json: '["codex"]',
          expires_at: Date.now() + 60000,
          revoked_at: null,
          consumed_run_id: "run1",
          reason: "test",
        },
      ],
    });
    client.revoke.mockRejectedValueOnce(new Error("Owner-Anmeldung erforderlich"));
    render(<SandboxAccessPanel {...client} />);
    await userEvent.click(await screen.findByRole("button", { name: "Widerrufen" }));
    expect(client.revoke).toHaveBeenCalledWith("grant1", "Vom Owner in der Sandbox-Ansicht widerrufen");
    expect(await screen.findByRole("alert")).toHaveTextContent("Owner-Anmeldung erforderlich");
  });
});
