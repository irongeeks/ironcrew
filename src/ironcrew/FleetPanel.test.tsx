import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { request } from "../api/core";
import { FleetPanel } from "./FleetPanel";
vi.mock("../api/core", () => ({ request: vi.fn() }));
const mock = vi.mocked(request);
const worker = {
  id: "worker-one",
  label: "Test Runner",
  state: "enrolling",
  workspaceRoot: "/srv/crew/test",
  runtimeTypes: ["codex"],
  projectIds: ["project-one"],
  maxConcurrent: 1,
  activeLeases: 0,
  lastSeenAt: null,
  credentialExpiresAt: null,
};
const projects = [{ id: "project-one", title: "Testprojekt" }];
const token = "test-only-enrollment-token-<img src=x onerror=alert(1)>";
beforeEach(() => {
  mock.mockReset();
  mock.mockImplementation(async (url) =>
    String(url).endsWith("/enrollments")
      ? { worker, enrollment: { token, expiresAt: Date.now() + 600_000 } }
      : { workers: [] },
  );
});
afterEach(() => vi.restoreAllMocks());
async function enroll() {
  fireEvent.change(screen.getByLabelText("Runner-Name"), { target: { value: "Test Runner" } });
  fireEvent.change(screen.getByLabelText("Workspace auf dem Runner"), { target: { value: "/srv/crew/test" } });
  fireEvent.change(screen.getByLabelText("Projekt"), { target: { value: "project-one" } });
  await userEvent.click(screen.getByRole("button", { name: "Einmalige Anmeldung erstellen" }));
  await screen.findByText(token);
  await waitFor(() => expect(screen.getByRole("button", { name: "Einmalige Anmeldung erstellen" })).toBeEnabled());
}
describe("FleetPanel", () => {
  it("submits explicit project, workspace, runtime, concurrency and short enrollment scope", async () => {
    render(<FleetPanel projects={projects} />);
    expect(screen.getByRole("button", { name: "Einmalige Anmeldung erstellen" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Runtime"), { target: { value: "claude" } });
    fireEvent.change(screen.getByLabelText("Parallele Runs"), { target: { value: "2" } });
    await enroll();
    const call = mock.mock.calls.find(([url]) => url === "/api/crew/fleet/enrollments");
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      label: "Test Runner",
      workspaceRoot: "/srv/crew/test",
      runtimeTypes: ["claude"],
      projectIds: ["project-one"],
      allowUnscoped: false,
      maxConcurrent: 2,
      ttlSeconds: 600,
    });
  });
  it("renders the one-time token as inert React text and clears it without browser persistence", async () => {
    const storage = vi.spyOn(Storage.prototype, "setItem");
    const view = render(<FleetPanel projects={projects} />);
    await enroll();
    expect(screen.getByText(token).tagName).toBe("CODE");
    expect(view.container.querySelector("img")).toBeNull();
    expect(storage).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Token ausblenden" }));
    expect(screen.queryByText(token)).not.toBeInTheDocument();
    await enroll();
    view.unmount();
    await act(async () => {
      render(<FleetPanel projects={projects} canManage={false} />);
    });
    expect(screen.queryByText(token)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Einmalige Anmeldung erstellen" })).not.toBeInTheDocument();
    expect(storage).not.toHaveBeenCalled();
  });
  it("requires explicit revoke confirmation and preserves current worker state when revoke fails", async () => {
    mock.mockImplementation(async (_url, options) => {
      if (options?.method === "POST") throw new Error("Widerruf fehlgeschlagen");
      return { workers: [{ ...worker, state: "active" }] };
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<FleetPanel projects={projects} />);
    const button = await screen.findByRole("button", { name: "Zugriff widerrufen" });
    await userEvent.click(button);
    expect(mock.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(0);
    confirm.mockReturnValue(true);
    await userEvent.click(button);
    expect(await screen.findByRole("alert")).toHaveTextContent("Widerruf fehlgeschlagen");
    expect(mock).toHaveBeenCalledWith("/api/crew/fleet/workers/worker-one/revoke", {
      method: "POST",
      headers: expect.any(Headers),
      body: "{}",
    });
    expect(screen.getByText(/active · 0\/1 Runs/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Zugriff widerrufen" })).toBeEnabled());
  });
});
