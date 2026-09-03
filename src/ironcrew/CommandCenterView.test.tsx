import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CommandCenterView } from "./CommandCenterView.tsx";
import type { api } from "./api.ts";
import type {
  Agent,
  Approval,
  Attachment,
  Dashboard,
  Decision,
  Department,
  Message,
  Milestone,
  Notification,
  Project,
  RuntimeInfo,
  Secret,
  SecretProviderStatus,
  Task,
} from "./types.ts";

function agent(over: Partial<Agent> = {}): Agent {
  return {
    id: "agt_1",
    key: "cto",
    displayName: "Forge",
    professionalRole: "chief_technology_officer",
    roleSummary: "",
    seniority: "executive",
    departmentId: "dept_1",
    runtimeProfile: "coding",
    runtimeProvider: "mock",
    isExecutiveAssistant: false,
    persona: {
      display_name: "Forge",
      accent: "cyan",
      traits: ["inventive"],
      forbidden_traits: [],
      portrait: null,
      full_body: null,
      model_3d: null,
    },
    policy: {
      may_delegate: true,
      may_create_tasks: true,
      may_approve: false,
      max_risk_level: "medium",
      allowed_tools: ["file_read"],
      requires_approval_for: ["production_deployment"],
    },
    status: "idle",
    ...over,
  };
}

function task(over: Partial<Task> = {}): Task {
  return {
    id: "task_1",
    title: "Backup dokumentieren",
    description: "…",
    status: "ready",
    priority: "normal",
    risk_level: "low",
    sensitive: 0,
    assigned_agent_id: "agt_1",
    result_summary: null,
    review_notes: null,
    correlation_id: "corr_1",
    created_at: Date.now(),
    updated_at: Date.now(),
    ...over,
  };
}

function dashboard(over: Partial<Dashboard> = {}): Dashboard {
  return {
    generatedAt: Date.now(),
    source: "live",
    tasks: { running: 0, blocked: 0, review: 0, approvalRequired: 0, done: 0, failed: 0, total: 1 },
    agents: { total: 1, working: 0, rateLimited: 0, waitingForApproval: 0 },
    approvalsPending: 0,
    budgets: [],
    auditChainValid: true,
    ...over,
  };
}

type Client = typeof api;

function makeClient(over: Partial<Record<keyof Client, unknown>> = {}) {
  return {
    company: vi.fn().mockResolvedValue({ company: { name: "IronCrew" }, departments: [] }),
    agents: vi.fn().mockResolvedValue({ agents: [agent()] }),
    tasks: vi.fn().mockResolvedValue({ tasks: [task()] }),
    chat: vi.fn().mockResolvedValue({ conversationId: "conv_1", messages: [] as Message[] }),
    approvals: vi.fn().mockResolvedValue({ approvals: [] as Approval[] }),
    dashboard: vi.fn().mockResolvedValue(dashboard()),
    sendMessage: vi.fn().mockResolvedValue({ reply: "ok", task: task() }),
    executeNext: vi.fn().mockResolvedValue({ executed: false }),
    accept: vi.fn().mockResolvedValue({ task: task({ status: "done" }) }),
    revise: vi.fn().mockResolvedValue({ task: task({ status: "ready" }) }),
    decide: vi.fn().mockResolvedValue({ approval: {} }),
    runEvents: vi.fn().mockResolvedValue({ events: [] }),
    task: vi.fn().mockResolvedValue({ task: task(), runs: [], audit: [], blockers: [], blocking: [] }),
    runtimes: vi.fn().mockResolvedValue({ runtimes: [runtimeInfo()] }),
    setAgentRuntime: vi.fn().mockResolvedValue({ agent: agent({ runtimeProvider: "claude" }) }),
    goals: vi.fn().mockResolvedValue({ goals: [] }),
    goal: vi.fn(),
    createGoal: vi.fn(),
    setGoalStatus: vi.fn(),
    projects: vi.fn().mockResolvedValue({ projects: [] }),
    project: vi.fn(),
    createProject: vi.fn(),
    setProjectStatus: vi.fn(),
    addMilestone: vi.fn(),
    setMilestoneStatus: vi.fn(),
    addDependency: vi.fn(),
    removeDependency: vi.fn(),
    notifications: vi.fn().mockResolvedValue({ notifications: [], unreadCount: 0 }),
    markNotificationRead: vi.fn(),
    decisions: vi.fn().mockResolvedValue({ decisions: [] }),
    secretProviders: vi.fn().mockResolvedValue({ providers: [] }),
    secrets: vi.fn().mockResolvedValue({ secrets: [] }),
    createSecret: vi.fn(),
    deleteSecret: vi.fn(),
    testSecret: vi.fn(),
    attachmentsForTask: vi.fn().mockResolvedValue({ attachments: [] }),
    attachmentsForProject: vi.fn().mockResolvedValue({ attachments: [] }),
    attachmentsGeneral: vi.fn().mockResolvedValue({ attachments: [] }),
    uploadAttachment: vi.fn(),
    deleteAttachment: vi.fn(),
    attachmentDownloadUrl: vi.fn((id: string) => `/api/crew/attachments/${id}/download`),
    ...over,
  } as unknown as Client;
}

function runtimeInfo(over: Partial<RuntimeInfo> = {}): RuntimeInfo {
  return {
    type: "mock",
    capabilities: {
      streaming: true,
      sessionResume: false,
      usageReporting: false,
      costReporting: false,
      toolCalls: true,
      subagents: false,
      defaultConcurrency: 1,
    },
    health: { healthy: true, installed: true, detail: "MockRuntime is always available.", checkedAt: Date.now() },
    auth: { authenticated: true, method: "subscription-cli", detail: "n/a" },
    ...over,
  };
}

function project(over: Partial<Project> = {}): Project {
  return {
    id: "prj_1",
    goal_id: null,
    key: "website-relaunch",
    title: "Website Relaunch",
    summary: "",
    status: "active",
    owner_agent_id: null,
    workspace_path: null,
    created_at: Date.now(),
    updated_at: Date.now(),
    ...over,
  };
}

function milestone(over: Partial<Milestone> = {}): Milestone {
  return {
    id: "mile_1",
    project_id: "prj_1",
    title: "Design freeze",
    description: "",
    status: "pending",
    due_at: null,
    sort_order: 0,
    created_at: Date.now(),
    completed_at: null,
    ...over,
  };
}

function notification(over: Partial<Notification> = {}): Notification {
  return {
    id: "ntf_1",
    kind: "approval_required",
    severity: "warning",
    title: "Freigabe nötig",
    body: "",
    task_id: null,
    approval_id: "apr_1",
    read_at: null,
    created_at: Date.now(),
    ...over,
  };
}

function decisionRecord(over: Partial<Decision> = {}): Decision {
  return {
    id: "dec_1",
    project_id: null,
    task_id: null,
    title: "Zahlung freigegeben",
    context: "",
    decision: "approved",
    rationale: "",
    decided_by: "ceo",
    created_at: Date.now(),
    ...over,
  };
}

function department(over: Partial<Department> = {}): Department {
  return { id: "dept_1", key: "engineering", name: "Engineering", description: "", ...over };
}

function secret(over: Partial<Secret> = {}): Secret {
  return {
    id: "secret_1",
    name: "github-pat",
    provider: "vaultwarden",
    item_ref: "github",
    field: null,
    description: "",
    created_at: Date.now(),
    updated_at: Date.now(),
    ...over,
  };
}

function secretProviderStatus(over: Partial<SecretProviderStatus> = {}): SecretProviderStatus {
  return { kind: "vaultwarden", registered: true, ok: true, message: "bw status: unlocked", ...over };
}

function attachment(over: Partial<Attachment> = {}): Attachment {
  return {
    id: "att_1",
    task_id: null,
    project_id: null,
    filename: "notes.txt",
    content_type: "text/plain",
    size_bytes: 42,
    sha256: "deadbeef",
    uploaded_by: "ceo",
    created_at: Date.now(),
    ...over,
  };
}

/** jsdom has no real HTML5 drag-and-drop; this is the standard RTL stand-in. */
function fakeDataTransfer() {
  const store: Record<string, string> = {};
  return {
    setData: (type: string, val: string) => {
      store[type] = val;
    },
    getData: (type: string) => store[type] ?? "",
    effectAllowed: "",
  };
}

beforeEach(() => vi.clearAllMocks());

describe("shell", () => {
  it("renders the command center, not a retro office", async () => {
    render(<CommandCenterView client={makeClient()} />);
    expect(await screen.findByTestId("command-center")).toBeInTheDocument();
    expect(screen.getByText("IRONCREW")).toBeInTheDocument();
    expect(screen.queryByText(/retro/i)).not.toBeInTheDocument();
  });

  it("shows the company name from the backend", async () => {
    const client = makeClient({
      company: vi.fn().mockResolvedValue({ company: { name: "Irongeeks GmbH" }, departments: [] }),
    });
    render(<CommandCenterView client={client} />);
    expect(await screen.findByText("Irongeeks GmbH")).toBeInTheDocument();
  });

  it("renders every board column with a German label", async () => {
    render(<CommandCenterView client={makeClient()} />);
    // Scoped to the board: some labels ("Läuft") legitimately also appear as
    // top-bar metric labels.
    const board = await screen.findByTestId("kanban");
    for (const label of ["Eingang", "Bereit", "Läuft", "Review", "Freigabe nötig", "Erledigt"]) {
      expect(within(board).getByText(label)).toBeInTheDocument();
    }
  });

  it("places a task in the column matching its backend status", async () => {
    const client = makeClient({ tasks: vi.fn().mockResolvedValue({ tasks: [task({ status: "review" })] }) });
    render(<CommandCenterView client={client} />);
    const column = await screen.findByTestId("column-review");
    expect(within(column).getByText("Backup dokumentieren")).toBeInTheDocument();
    expect(within(await screen.findByTestId("column-ready")).queryByText("Backup dokumentieren")).toBeNull();
  });
});

describe("Kanban drag & drop", () => {
  it("moves a card to a new column once the server accepts the transition", async () => {
    const setTaskStatus = vi.fn().mockResolvedValue({ task: task({ status: "blocked" }) });
    const client = makeClient({
      tasks: vi
        .fn()
        .mockResolvedValueOnce({ tasks: [task({ status: "ready" })] })
        .mockResolvedValue({ tasks: [task({ status: "blocked" })] }),
      setTaskStatus,
    });
    render(<CommandCenterView client={client} />);

    const card = (await screen.findByText("Backup dokumentieren")).closest("button")!;
    const dt = fakeDataTransfer();
    fireEvent.dragStart(card, { dataTransfer: dt });
    const target = await screen.findByTestId("column-blocked");
    fireEvent.dragOver(target, { dataTransfer: dt });
    fireEvent.drop(target, { dataTransfer: dt });

    expect(setTaskStatus).toHaveBeenCalledWith("task_1", "blocked");
    await waitFor(() => {
      expect(within(screen.getByTestId("column-blocked")).getByText("Backup dokumentieren")).toBeInTheDocument();
    });
    expect(within(screen.getByTestId("column-ready")).queryByText("Backup dokumentieren")).toBeNull();
  });

  it("leaves the card in place when the server rejects the move", async () => {
    const setTaskStatus = vi.fn().mockRejectedValue(new Error("409: invalid_transition"));
    const client = makeClient({
      tasks: vi.fn().mockResolvedValue({ tasks: [task({ status: "ready" })] }),
      setTaskStatus,
    });
    render(<CommandCenterView client={client} />);

    const card = (await screen.findByText("Backup dokumentieren")).closest("button")!;
    const dt = fakeDataTransfer();
    fireEvent.dragStart(card, { dataTransfer: dt });
    const target = await screen.findByTestId("column-done");
    fireEvent.dragOver(target, { dataTransfer: dt });
    fireEvent.drop(target, { dataTransfer: dt });

    await waitFor(() => expect(setTaskStatus).toHaveBeenCalled());
    // The board only ever reflects what the backend returned — never a
    // locally-applied move — so the card is still in "ready" and the
    // rejection surfaces as an error, exactly like any other action.
    expect(within(screen.getByTestId("column-ready")).getByText("Backup dokumentieren")).toBeInTheDocument();
    expect(within(screen.getByTestId("column-done")).queryByText("Backup dokumentieren")).toBeNull();
    expect(await screen.findByTestId("error-banner")).toBeInTheDocument();
  });

  it("does not call the API when a card is dropped back on its own column", async () => {
    const setTaskStatus = vi.fn();
    const client = makeClient({
      tasks: vi.fn().mockResolvedValue({ tasks: [task({ status: "ready" })] }),
      setTaskStatus,
    });
    render(<CommandCenterView client={client} />);

    const card = (await screen.findByText("Backup dokumentieren")).closest("button")!;
    const dt = fakeDataTransfer();
    fireEvent.dragStart(card, { dataTransfer: dt });
    const target = await screen.findByTestId("column-ready");
    fireEvent.dragOver(target, { dataTransfer: dt });
    fireEvent.drop(target, { dataTransfer: dt });

    expect(setTaskStatus).not.toHaveBeenCalled();
  });
});

describe("dashboard figures come from the backend", () => {
  it("renders live counts rather than placeholders", async () => {
    const client = makeClient({
      dashboard: vi.fn().mockResolvedValue(
        dashboard({
          tasks: { running: 3, blocked: 2, review: 1, approvalRequired: 4, done: 9, failed: 0, total: 19 },
          agents: { total: 5, working: 3, rateLimited: 1, waitingForApproval: 0 },
          approvalsPending: 4,
        }),
      ),
    });
    render(<CommandCenterView client={client} />);
    const metrics = await screen.findByRole("group", { name: "Systemkennzahlen" });

    // Read each metric by its own label; several metrics can share a value.
    const valueFor = (label: string): string | null => {
      const el = within(metrics).getByText(label).parentElement;
      return el?.querySelector(".ic-metric-value")?.textContent ?? null;
    };
    expect(valueFor("Läuft")).toBe("3");
    expect(valueFor("Review")).toBe("1");
    expect(valueFor("Freigaben")).toBe("4");
    expect(valueFor("Blockiert")).toBe("2");
    expect(valueFor("Agents aktiv")).toBe("3");
  });

  it("flags a broken audit chain instead of hiding it", async () => {
    const client = makeClient({
      dashboard: vi.fn().mockResolvedValue(dashboard({ auditChainValid: false })),
    });
    render(<CommandCenterView client={client} />);
    expect(await screen.findByText("BRUCH")).toBeInTheDocument();
  });
});

describe("agent status mirrors backend state", () => {
  it.each([
    ["working", "Arbeitet"],
    ["waiting_for_approval", "Wartet auf Freigabe"],
    ["rate_limited", "Rate-Limit"],
    ["error", "Fehler"],
    ["idle", "Bereit"],
  ])("renders %s as %s", async (status, label) => {
    const client = makeClient({
      agents: vi.fn().mockResolvedValue({ agents: [agent({ status: status as Agent["status"] })] }),
    });
    render(<CommandCenterView client={client} />);
    const dot = await screen.findByTestId("agent-status-cto");
    expect(dot).toHaveAttribute("data-status", status);
    // Status is available as text too, not only as colour.
    expect(screen.getByText(`Status: ${label}`)).toBeInTheDocument();
  });

  it("marks the executive assistant", async () => {
    const client = makeClient({
      agents: vi.fn().mockResolvedValue({ agents: [agent({ key: "ea", isExecutiveAssistant: true })] }),
    });
    render(<CommandCenterView client={client} />);
    expect(await screen.findByText("EA")).toBeInTheDocument();
  });
});

describe("CEO chat", () => {
  it("sends a message and refreshes", async () => {
    const user = userEvent.setup();
    const client = makeClient();
    render(<CommandCenterView client={client} />);
    await screen.findByTestId("chat-input");

    await user.type(screen.getByTestId("chat-input"), "Bitte dokumentiere das Backup.");
    await user.click(screen.getByTestId("chat-send"));

    await waitFor(() => expect(client.sendMessage).toHaveBeenCalledWith("Bitte dokumentiere das Backup."));
  });

  it("disables send for an empty draft", async () => {
    render(<CommandCenterView client={makeClient()} />);
    expect(await screen.findByTestId("chat-send")).toBeDisabled();
  });

  it("shows the triage decision on a CEO message", async () => {
    const client = makeClient({
      chat: vi.fn().mockResolvedValue({
        conversationId: "c",
        messages: [
          {
            id: "m1",
            role: "ceo",
            author_agent_id: null,
            body: "Bitte prüfen",
            task_id: null,
            created_at: Date.now(),
            triage_json: JSON.stringify({ category: "simple_task", confidence: 0.75 }),
          },
        ],
      }),
    });
    render(<CommandCenterView client={client} />);
    expect(await screen.findByText(/simple_task/)).toBeInTheDocument();
    expect(screen.getByText(/75%/)).toBeInTheDocument();
  });

  it("explains the EA-first model when the channel is empty", async () => {
    render(<CommandCenterView client={makeClient()} />);
    expect(await screen.findByText(/zentraler Ansprechpartner/)).toBeInTheDocument();
  });
});

describe("decisions belong to the CEO", () => {
  it("renders a pending approval with approve and reject", async () => {
    const approval: Approval = {
      id: "apr_1",
      approval_type: "bank_transfer",
      summary: "4.500 EUR an Lieferant",
      risk_level: "high",
      impact: "",
      rollback_plan: "",
      status: "pending",
      task_id: "task_1",
      created_at: Date.now(),
    };
    const client = makeClient({ approvals: vi.fn().mockResolvedValue({ approvals: [approval] }) });
    render(<CommandCenterView client={client} />);

    const card = await screen.findByTestId("approval-apr_1");
    expect(within(card).getByText("bank_transfer")).toBeInTheDocument();
    expect(within(card).getByText("4.500 EUR an Lieferant")).toBeInTheDocument();

    await userEvent.setup().click(within(card).getByRole("button", { name: "Freigeben" }));
    await waitFor(() => expect(client.decide).toHaveBeenCalledWith("apr_1", "approved"));
  });

  it("offers accept and revision for a task in review", async () => {
    const user = userEvent.setup();
    const client = makeClient({ tasks: vi.fn().mockResolvedValue({ tasks: [task({ status: "review" })] }) });
    render(<CommandCenterView client={client} />);

    const card = await screen.findByTestId("review-task_1");
    await user.click(within(card).getByRole("button", { name: "Abnehmen" }));
    await waitFor(() => expect(client.accept).toHaveBeenCalledWith("task_1"));

    await user.click(within(await screen.findByTestId("review-task_1")).getByRole("button", { name: "Revision" }));
    await waitFor(() => expect(client.revise).toHaveBeenCalled());
  });
});

describe("execution and events", () => {
  it("runs the next task and appends its events", async () => {
    const client = makeClient({
      executeNext: vi.fn().mockResolvedValue({ executed: true, runId: "run_1", task: task({ status: "review" }) }),
      runEvents: vi.fn().mockResolvedValue({
        events: [
          {
            eventId: "e1",
            type: "run.started",
            seq: 0,
            timestamp: Date.now(),
            taskId: "task_1",
            runId: "run_1",
            payload: {},
            redaction: { redacted: false, rules: [] },
          },
          {
            eventId: "e2",
            type: "run.completed",
            seq: 1,
            timestamp: Date.now(),
            taskId: "task_1",
            runId: "run_1",
            payload: { summary: "fertig" },
            redaction: { redacted: false, rules: [] },
          },
        ],
      }),
    });
    render(<CommandCenterView client={client} />);
    await userEvent.setup().click(await screen.findByTestId("run-next"));

    const log = await screen.findByTestId("event-log");
    await waitFor(() => expect(within(log).getByText("run.started")).toBeInTheDocument());
    expect(within(log).getByText("run.completed")).toBeInTheDocument();
  });

  it("marks a redacted event so the redaction is visible", async () => {
    const client = makeClient({
      executeNext: vi.fn().mockResolvedValue({ executed: true, runId: "run_1" }),
      runEvents: vi.fn().mockResolvedValue({
        events: [
          {
            eventId: "e1",
            type: "tool.completed",
            seq: 0,
            timestamp: Date.now(),
            taskId: "task_1",
            runId: "run_1",
            payload: { output: "[REDACTED]" },
            redaction: { redacted: true, rules: ["anthropic_key"] },
          },
        ],
      }),
    });
    render(<CommandCenterView client={client} />);
    await userEvent.setup().click(await screen.findByTestId("run-next"));
    expect(await screen.findByText("redigiert")).toBeInTheDocument();
  });
});

describe("errors are surfaced, never swallowed", () => {
  it("shows a budget stop as an actionable message", async () => {
    const client = makeClient({
      executeNext: vi.fn().mockRejectedValue(new Error("402: Budget hard stop for company")),
    });
    render(<CommandCenterView client={client} />);
    await userEvent.setup().click(await screen.findByTestId("run-next"));
    const banner = await screen.findByTestId("error-banner");
    expect(within(banner).getByText(/Budget hard stop/)).toBeInTheDocument();
  });

  it("shows a load failure rather than rendering an empty shell silently", async () => {
    const client = makeClient({ agents: vi.fn().mockRejectedValue(new Error("500: control plane down")) });
    render(<CommandCenterView client={client} />);
    expect(await screen.findByTestId("error-banner")).toHaveTextContent("control plane down");
  });
});

describe("task detail — dependencies", () => {
  it("shows blockers and blocking tasks fetched for the selected task", async () => {
    const client = makeClient({
      task: vi.fn().mockResolvedValue({
        task: task(),
        runs: [],
        audit: [],
        blockers: [task({ id: "task_2", title: "Design freeze" })],
        blocking: [task({ id: "task_3", title: "Launch" })],
      }),
    });
    render(<CommandCenterView client={client} />);
    await userEvent.setup().click(await screen.findByText("Backup dokumentieren"));

    const dialog = await screen.findByRole("dialog", { name: "Backup dokumentieren" });
    expect(within(dialog).getByText("Design freeze")).toBeInTheDocument();
    expect(within(dialog).getByText("Launch")).toBeInTheDocument();
  });

  it("adds a blocker via the select and refreshes the list", async () => {
    const addDependency = vi.fn().mockResolvedValue({ blockers: [] });
    const client = makeClient({
      tasks: vi.fn().mockResolvedValue({ tasks: [task(), task({ id: "task_2", title: "Design freeze" })] }),
      task: vi
        .fn()
        .mockResolvedValueOnce({ task: task(), runs: [], audit: [], blockers: [], blocking: [] })
        .mockResolvedValue({
          task: task(),
          runs: [],
          audit: [],
          blockers: [task({ id: "task_2", title: "Design freeze" })],
          blocking: [],
        }),
      addDependency,
    });
    render(<CommandCenterView client={client} />);
    await userEvent.setup().click(await screen.findByText("Backup dokumentieren"));

    const dialog = await screen.findByRole("dialog", { name: "Backup dokumentieren" });
    const user = userEvent.setup();
    await user.selectOptions(within(dialog).getByLabelText(/Blocker für/), "task_2");
    await user.click(within(dialog).getByRole("button", { name: "Hinzufügen" }));

    expect(addDependency).toHaveBeenCalledWith("task_1", "task_2");
    await waitFor(() => expect(within(dialog).getByText("Design freeze")).toBeInTheDocument());
  });

  it("removes a blocker", async () => {
    const removeDependency = vi.fn().mockResolvedValue({ blockers: [] });
    const client = makeClient({
      task: vi
        .fn()
        .mockResolvedValueOnce({
          task: task(),
          runs: [],
          audit: [],
          blockers: [task({ id: "task_2", title: "Design freeze" })],
          blocking: [],
        })
        .mockResolvedValue({ task: task(), runs: [], audit: [], blockers: [], blocking: [] }),
      removeDependency,
    });
    render(<CommandCenterView client={client} />);
    await userEvent.setup().click(await screen.findByText("Backup dokumentieren"));

    const dialog = await screen.findByRole("dialog", { name: "Backup dokumentieren" });
    await userEvent.setup().click(within(dialog).getByRole("button", { name: "Entfernen" }));

    expect(removeDependency).toHaveBeenCalledWith("task_1", "task_2");
    await waitFor(() => expect(within(dialog).queryByText("Design freeze")).toBeNull());
  });
});

describe("agent detail", () => {
  it("shows policy separately from persona and states policy wins", async () => {
    render(<CommandCenterView client={makeClient()} />);
    // Scoped to the roster: the agent name also appears on its task card.
    const roster = await screen.findByRole("navigation", { name: "Mannschaft" });
    await userEvent.setup().click(within(roster).getByRole("button", { name: /Forge/ }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("file_read")).toBeInTheDocument();
    expect(within(dialog).getByText("production_deployment")).toBeInTheDocument();
    expect(within(dialog).getByText(/Policy hat immer Vorrang/)).toBeInTheDocument();
  });

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    render(<CommandCenterView client={makeClient()} />);
    const roster = await screen.findByRole("navigation", { name: "Mannschaft" });
    await user.click(within(roster).getByRole("button", { name: /Forge/ }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});

describe("runtime selection", () => {
  it("lists every registered runtime with a health marker", async () => {
    const client = makeClient({
      runtimes: vi.fn().mockResolvedValue({
        runtimes: [
          runtimeInfo({ type: "mock" }),
          runtimeInfo({
            type: "claude",
            health: { healthy: false, installed: false, detail: "claude CLI is not installed.", checkedAt: Date.now() },
          }),
        ],
      }),
    });
    render(<CommandCenterView client={client} />);
    const roster = await screen.findByRole("navigation", { name: "Mannschaft" });
    await userEvent.setup().click(within(roster).getByRole("button", { name: /Forge/ }));

    const select = await screen.findByTestId("agent-runtime-select");
    await waitFor(() => expect(client.runtimes).toHaveBeenCalled());
    const options = within(select).getAllByRole("option") as HTMLOptionElement[];
    expect(options.map((o) => o.value)).toEqual(["mock", "claude"]);
    expect(options[1].textContent).toContain("nicht verfügbar");
  });

  it("moves an agent onto a different runtime and reflects it immediately", async () => {
    const setAgentRuntime = vi.fn().mockResolvedValue({ agent: agent({ runtimeProvider: "claude" }) });
    const client = makeClient({
      setAgentRuntime,
      runtimes: vi
        .fn()
        .mockResolvedValue({ runtimes: [runtimeInfo({ type: "mock" }), runtimeInfo({ type: "claude" })] }),
      // After the change, /agents must report the new provider too — the
      // dialog is derived from the live agents list, not a local echo.
      agents: vi
        .fn()
        .mockResolvedValueOnce({ agents: [agent()] })
        .mockResolvedValue({ agents: [agent({ runtimeProvider: "claude" })] }),
    });
    render(<CommandCenterView client={client} />);
    const roster = await screen.findByRole("navigation", { name: "Mannschaft" });
    await userEvent.setup().click(within(roster).getByRole("button", { name: /Forge/ }));

    const select = await screen.findByTestId("agent-runtime-select");
    await userEvent.setup().selectOptions(select, "claude");

    expect(setAgentRuntime).toHaveBeenCalledWith("agt_1", "claude");
    await waitFor(() => expect((select as HTMLSelectElement).value).toBe("claude"));
  });

  it("surfaces an agent's provider even when this install no longer has it registered", async () => {
    const client = makeClient({
      agents: vi.fn().mockResolvedValue({ agents: [agent({ runtimeProvider: "codex" })] }),
      runtimes: vi.fn().mockResolvedValue({ runtimes: [runtimeInfo({ type: "mock" })] }),
    });
    render(<CommandCenterView client={client} />);
    const roster = await screen.findByRole("navigation", { name: "Mannschaft" });
    await userEvent.setup().click(within(roster).getByRole("button", { name: /Forge/ }));

    const select = await screen.findByTestId("agent-runtime-select");
    await waitFor(() => expect(client.runtimes).toHaveBeenCalled());
    expect(within(select).getByText(/codex \(nicht registriert\)/)).toBeInTheDocument();
  });
});

describe("projects", () => {
  it("lists projects and opens a project's detail on click", async () => {
    const client = makeClient({
      projects: vi.fn().mockResolvedValue({ projects: [project()] }),
      project: vi.fn().mockResolvedValue({
        project: project(),
        milestones: [milestone()],
        tasks: [task({ id: "task_2", title: "Redesign the pricing page" })],
      }),
    });
    render(<CommandCenterView client={client} />);

    const openButton = await screen.findByTestId("open-projects");
    expect(openButton).toHaveTextContent("Projekte (1)");
    await userEvent.setup().click(openButton);

    const listDialog = await screen.findByRole("dialog", { name: "Projekte" });
    await userEvent.setup().click(within(listDialog).getByTestId("project-website-relaunch"));

    const detail = await screen.findByRole("dialog", { name: "Website Relaunch" });
    expect(within(detail).getByText("website-relaunch")).toBeInTheDocument();
    expect(within(detail).getByText("Design freeze")).toBeInTheDocument();
    expect(within(detail).getByText("Redesign the pricing page")).toBeInTheDocument();
    // The list dialog is replaced, not stacked.
    expect(screen.queryByRole("dialog", { name: "Projekte" })).toBeNull();
  });

  it("shows the goal ancestry breadcrumb when the project traces to a goal", async () => {
    const client = makeClient({
      projects: vi.fn().mockResolvedValue({ projects: [project({ goal_id: "goal_1" })] }),
      project: vi.fn().mockResolvedValue({
        project: project({ goal_id: "goal_1" }),
        milestones: [],
        tasks: [],
      }),
      goal: vi.fn().mockResolvedValue({
        goal: {
          id: "goal_1",
          parent_id: null,
          title: "Grow revenue 20%",
          description: "",
          status: "active",
          created_at: 0,
        },
        ancestry: [
          {
            id: "goal_0",
            parent_id: null,
            title: "Grow the company",
            description: "",
            status: "active",
            created_at: 0,
          },
          {
            id: "goal_1",
            parent_id: "goal_0",
            title: "Grow revenue 20%",
            description: "",
            status: "active",
            created_at: 0,
          },
        ],
        children: [],
      }),
    });
    render(<CommandCenterView client={client} />);

    await userEvent.setup().click(await screen.findByTestId("open-projects"));
    await userEvent.setup().click(await screen.findByTestId("project-website-relaunch"));

    const breadcrumb = await screen.findByTestId("project-goal-ancestry");
    expect(breadcrumb).toHaveTextContent("Grow the company -> Grow revenue 20%");
  });

  it("marks a milestone done from the project detail view", async () => {
    const setMilestoneStatus = vi.fn().mockResolvedValue({ milestone: milestone({ status: "done" }) });
    const client = makeClient({
      projects: vi.fn().mockResolvedValue({ projects: [project()] }),
      project: vi
        .fn()
        .mockResolvedValueOnce({ project: project(), milestones: [milestone()], tasks: [] })
        .mockResolvedValue({ project: project(), milestones: [milestone({ status: "done" })], tasks: [] }),
      setMilestoneStatus,
    });
    render(<CommandCenterView client={client} />);

    await userEvent.setup().click(await screen.findByTestId("open-projects"));
    await userEvent.setup().click(await screen.findByTestId("project-website-relaunch"));

    const detail = await screen.findByRole("dialog", { name: "Website Relaunch" });
    await userEvent.setup().click(within(detail).getByRole("button", { name: "Erledigt" }));

    expect(setMilestoneStatus).toHaveBeenCalledWith("mile_1", "done");
    await waitFor(() => expect(within(detail).queryByRole("button", { name: "Erledigt" })).toBeNull());
  });
});

describe("decision inbox", () => {
  it("shows the unread count on the topbar button", async () => {
    const client = makeClient({
      notifications: vi.fn().mockResolvedValue({ notifications: [notification()], unreadCount: 1 }),
    });
    render(<CommandCenterView client={client} />);
    expect(await screen.findByTestId("open-inbox")).toHaveTextContent("Postfach (1)");
  });

  it("lists notifications and the decision log, and marks a notification read", async () => {
    const markNotificationRead = vi.fn().mockResolvedValue({ notification: notification({ read_at: Date.now() }) });
    const client = makeClient({
      notifications: vi
        .fn()
        .mockResolvedValueOnce({ notifications: [notification()], unreadCount: 1 })
        .mockResolvedValue({ notifications: [notification({ read_at: Date.now() })], unreadCount: 0 }),
      decisions: vi.fn().mockResolvedValue({ decisions: [decisionRecord()] }),
      markNotificationRead,
    });
    render(<CommandCenterView client={client} />);

    await userEvent.setup().click(await screen.findByTestId("open-inbox"));
    const dialog = await screen.findByRole("dialog", { name: "Postfach" });
    expect(within(dialog).getByText("Freigabe nötig")).toBeInTheDocument();
    expect(within(dialog).getByText("Zahlung freigegeben")).toBeInTheDocument();

    await userEvent.setup().click(within(dialog).getByRole("button", { name: "Gelesen" }));
    expect(markNotificationRead).toHaveBeenCalledWith("ntf_1");
    await waitFor(() => expect(screen.getByTestId("open-inbox")).toHaveTextContent("Postfach (0)"));
  });
});

describe("org chart", () => {
  it("groups agents under their department, from live backend data", async () => {
    const client = makeClient({
      company: vi.fn().mockResolvedValue({
        company: { name: "IronCrew" },
        departments: [department(), department({ id: "dept_2", key: "sales", name: "Sales" })],
      }),
      agents: vi.fn().mockResolvedValue({ agents: [agent()] }),
    });
    render(<CommandCenterView client={client} />);

    await userEvent.setup().click(await screen.findByTestId("open-org-chart"));
    const dialog = await screen.findByRole("dialog", { name: "Organigramm" });

    const engineering = within(dialog).getByTestId("org-department-engineering");
    expect(within(engineering).getByText("Forge")).toBeInTheDocument();
    const sales = within(dialog).getByTestId("org-department-sales");
    expect(within(sales).queryByText("Forge")).toBeNull();
    expect(within(sales).getByText("—")).toBeInTheDocument();
  });

  it("opens the agent-detail dialog from an org chart entry", async () => {
    const client = makeClient({
      company: vi.fn().mockResolvedValue({ company: { name: "IronCrew" }, departments: [department()] }),
      agents: vi.fn().mockResolvedValue({ agents: [agent()] }),
    });
    render(<CommandCenterView client={client} />);

    await userEvent.setup().click(await screen.findByTestId("open-org-chart"));
    await userEvent.setup().click(await screen.findByTestId("org-agent-cto"));

    expect(await screen.findByRole("dialog", { name: "Forge" })).toBeInTheDocument();
  });
});

describe("secrets (password-manager integration)", () => {
  it("shows provider status and stored secret refs — never a value", async () => {
    const client = makeClient({
      secretProviders: vi.fn().mockResolvedValue({
        providers: [
          secretProviderStatus({ kind: "vaultwarden", ok: true, message: "bw status: unlocked" }),
          secretProviderStatus({ kind: "protonpass", registered: false, ok: false, message: "" }),
        ],
      }),
      secrets: vi.fn().mockResolvedValue({ secrets: [secret()] }),
    });
    render(<CommandCenterView client={client} />);

    await userEvent.setup().click(await screen.findByTestId("open-secrets"));
    const dialog = await screen.findByRole("dialog", { name: "Zugangsdaten" });

    expect(within(dialog).getByTestId("secret-provider-vaultwarden")).toHaveTextContent("verbunden");
    expect(within(dialog).getByTestId("secret-provider-protonpass")).toHaveTextContent("nicht registriert");
    expect(within(dialog).getByText("github-pat")).toBeInTheDocument();
    expect(within(dialog).getByText("github")).toBeInTheDocument();
    // The dialog never renders anything that looks like a resolved value.
    expect(dialog.textContent).not.toMatch(/value/i);
  });

  it("creates a secret ref via the form and refreshes the list", async () => {
    const createSecret = vi.fn().mockResolvedValue({ secret: secret() });
    const client = makeClient({
      secrets: vi
        .fn()
        .mockResolvedValueOnce({ secrets: [] })
        .mockResolvedValue({ secrets: [secret()] }),
      createSecret,
    });
    render(<CommandCenterView client={client} />);

    await userEvent.setup().click(await screen.findByTestId("open-secrets"));
    const dialog = await screen.findByRole("dialog", { name: "Zugangsdaten" });
    expect(within(dialog).getByText("—")).toBeInTheDocument();

    const user = userEvent.setup();
    await user.type(within(dialog).getByTestId("new-secret-name"), "github-pat");
    await user.type(within(dialog).getByTestId("new-secret-itemref"), "github");
    await user.click(within(dialog).getByTestId("new-secret-submit"));

    expect(createSecret).toHaveBeenCalledWith({
      name: "github-pat",
      provider: "vaultwarden",
      itemRef: "github",
      field: undefined,
    });
    expect(await within(dialog).findByText("github-pat")).toBeInTheDocument();
  });

  it("tests a secret ref and shows the result without ever showing a resolved value", async () => {
    const testSecret = vi.fn().mockResolvedValue({ ok: true, length: 12 });
    const client = makeClient({ secrets: vi.fn().mockResolvedValue({ secrets: [secret()] }), testSecret });
    render(<CommandCenterView client={client} />);

    await userEvent.setup().click(await screen.findByTestId("open-secrets"));
    const dialog = await screen.findByRole("dialog", { name: "Zugangsdaten" });
    await userEvent.setup().click(within(dialog).getByRole("button", { name: "Testen" }));

    expect(testSecret).toHaveBeenCalledWith("secret_1");
    expect(await within(dialog).findByTestId("secret-test-secret_1")).toHaveTextContent("OK (12 Zeichen)");
  });

  it("deletes a secret ref", async () => {
    const deleteSecret = vi.fn().mockResolvedValue({ ok: true });
    const client = makeClient({
      secrets: vi
        .fn()
        .mockResolvedValueOnce({ secrets: [secret()] })
        .mockResolvedValue({ secrets: [] }),
      deleteSecret,
    });
    render(<CommandCenterView client={client} />);

    await userEvent.setup().click(await screen.findByTestId("open-secrets"));
    const dialog = await screen.findByRole("dialog", { name: "Zugangsdaten" });
    await userEvent.setup().click(within(dialog).getByRole("button", { name: "Löschen" }));

    expect(deleteSecret).toHaveBeenCalledWith("secret_1");
    await waitFor(() => expect(within(dialog).queryByText("github-pat")).toBeNull());
  });
});

describe("attachments (task/project-scoped + the general document store)", () => {
  it("shows the general document store and uploads a file to it", async () => {
    const uploadAttachment = vi.fn().mockResolvedValue({ attachment: attachment() });
    const client = makeClient({
      attachmentsGeneral: vi
        .fn()
        .mockResolvedValueOnce({ attachments: [] })
        .mockResolvedValue({ attachments: [attachment()] }),
      uploadAttachment,
    });
    render(<CommandCenterView client={client} />);

    await userEvent.setup().click(await screen.findByTestId("open-documents"));
    const dialog = await screen.findByRole("dialog", { name: "Dokumente" });
    expect(within(dialog).getByText("—")).toBeInTheDocument();

    const file = new File(["hello"], "hello.txt", { type: "text/plain" });
    const input = within(dialog).getByTestId("attachment-upload-input");
    await userEvent.setup().upload(input, file);

    await waitFor(() => expect(uploadAttachment).toHaveBeenCalled());
    const call = uploadAttachment.mock.calls[0][0];
    expect(call.filename).toBe("hello.txt");
    expect(call.contentType).toBe("text/plain");
    expect(typeof call.dataBase64).toBe("string");
    expect(call.taskId).toBeUndefined();
    expect(call.projectId).toBeUndefined();
    expect(await within(dialog).findByText("notes.txt")).toBeInTheDocument();
  });

  it("shows and uploads a task-scoped attachment from the task detail dialog", async () => {
    const uploadAttachment = vi.fn().mockResolvedValue({ attachment: attachment({ task_id: "task_1" }) });
    const client = makeClient({
      attachmentsForTask: vi
        .fn()
        .mockResolvedValueOnce({ attachments: [] })
        .mockResolvedValue({ attachments: [attachment({ id: "att_2", task_id: "task_1", filename: "spec.pdf" })] }),
      uploadAttachment,
    });
    render(<CommandCenterView client={client} />);
    await userEvent.setup().click(await screen.findByText("Backup dokumentieren"));
    const dialog = await screen.findByRole("dialog", { name: "Backup dokumentieren" });

    const file = new File(["spec"], "spec.pdf", { type: "application/pdf" });
    await userEvent.setup().upload(within(dialog).getByTestId("attachment-upload-input"), file);

    await waitFor(() => expect(uploadAttachment).toHaveBeenCalled());
    expect(uploadAttachment.mock.calls[0][0]).toMatchObject({ filename: "spec.pdf", taskId: "task_1" });
    expect(await within(dialog).findByText("spec.pdf")).toBeInTheDocument();
  });

  it("deletes an attachment from the general document store", async () => {
    const deleteAttachment = vi.fn().mockResolvedValue({ ok: true });
    const client = makeClient({
      attachmentsGeneral: vi
        .fn()
        .mockResolvedValueOnce({ attachments: [attachment()] })
        .mockResolvedValue({ attachments: [] }),
      deleteAttachment,
    });
    render(<CommandCenterView client={client} />);

    await userEvent.setup().click(await screen.findByTestId("open-documents"));
    const dialog = await screen.findByRole("dialog", { name: "Dokumente" });
    await userEvent.setup().click(within(dialog).getByRole("button", { name: "Entfernen" }));

    expect(deleteAttachment).toHaveBeenCalledWith("att_1");
    await waitFor(() => expect(within(dialog).queryByText("notes.txt")).toBeNull());
  });

  it("links each attachment to its download URL", async () => {
    const client = makeClient({ attachmentsGeneral: vi.fn().mockResolvedValue({ attachments: [attachment()] }) });
    render(<CommandCenterView client={client} />);

    await userEvent.setup().click(await screen.findByTestId("open-documents"));
    const dialog = await screen.findByRole("dialog", { name: "Dokumente" });
    const link = await within(dialog).findByText("notes.txt");
    expect(link.closest("a")).toHaveAttribute("href", "/api/crew/attachments/att_1/download");
  });
});
