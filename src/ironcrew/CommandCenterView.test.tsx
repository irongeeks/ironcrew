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
  Mailbox,
  MailMessage,
  Meeting,
  MeetingActionItem,
  MeetingParticipant,
  MeetingTurn,
  MemoryProviderStatus,
  MemoryRef,
  Message,
  Milestone,
  Notification,
  NotificationChannelStatus,
  Project,
  RemoteWorker,
  RuntimeInfo,
  Secret,
  SecretProviderStatus,
  TailscaleInfo,
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
    tailscale: vi.fn().mockResolvedValue({ backendState: "Unknown", self: null, peers: [], ok: false, message: "" }),
    remoteWorkers: vi.fn().mockResolvedValue({ remoteWorkers: [] }),
    createRemoteWorker: vi.fn(),
    deleteRemoteWorker: vi.fn(),
    testRemoteWorker: vi.fn(),
    meetings: vi.fn().mockResolvedValue({ meetings: [] }),
    meeting: vi.fn(),
    createMeeting: vi.fn(),
    startMeeting: vi.fn(),
    nextMeetingTurn: vi.fn(),
    endMeeting: vi.fn(),
    cancelMeeting: vi.fn(),
    addMeetingActionItem: vi.fn(),
    convertActionItemToTask: vi.fn(),
    memoryProviders: vi.fn().mockResolvedValue({ providers: [] }),
    memories: vi.fn().mockResolvedValue({ memories: [] }),
    recordMemory: vi.fn(),
    memoryContent: vi.fn(),
    deleteMemory: vi.fn(),
    searchMemory: vi.fn(),
    notificationChannels: vi.fn().mockResolvedValue({ channels: [] }),
    testNotificationChannel: vi.fn(),
    sendTestNotification: vi.fn(),
    mailProviders: vi.fn().mockResolvedValue({ providers: [] }),
    mailboxes: vi.fn().mockResolvedValue({ mailboxes: [] }),
    mailbox: vi.fn(),
    createMailbox: vi.fn(),
    updateMailbox: vi.fn(),
    deleteMailbox: vi.fn(),
    testMailbox: vi.fn(),
    grantMailboxAgent: vi.fn(),
    revokeMailboxAgent: vi.fn(),
    mailboxMessages: vi.fn().mockResolvedValue({ messages: [] }),
    pollMailbox: vi.fn(),
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

function remoteWorker(over: Partial<RemoteWorker> = {}): RemoteWorker {
  return {
    id: "worker_1",
    label: "tier0-acme",
    environment: "customer:acme",
    host: "100.64.1.2",
    port: 22,
    ssh_user: "deploy",
    private_key_path: "/etc/ironcrew/keys/acme.pem",
    known_hosts_policy: "strict",
    notes: "",
    created_at: Date.now(),
    updated_at: Date.now(),
    ...over,
  };
}

function meeting(over: Partial<Meeting> = {}): Meeting {
  return {
    id: "mtg_1",
    company_id: "cmp_1",
    project_id: null,
    topic: "Sprint-Planung",
    status: "scheduled",
    moderator_agent_id: "agt_1",
    max_rounds: 6,
    budget_micros: 0,
    spent_micros: 0,
    current_round: 0,
    minutes: "",
    created_at: Date.now(),
    started_at: null,
    ended_at: null,
    ...over,
  };
}

function meetingDetail(
  over: {
    meeting?: Partial<Meeting>;
    participants?: MeetingParticipant[];
    turns?: MeetingTurn[];
    actionItems?: MeetingActionItem[];
  } = {},
): { meeting: Meeting; participants: MeetingParticipant[]; turns: MeetingTurn[]; actionItems: MeetingActionItem[] } {
  return {
    meeting: meeting(over.meeting),
    participants: over.participants ?? [
      { agent_id: "agt_1", key: "cto", display_name: "Forge", professional_role: "chief_technology_officer" },
      { agent_id: "agt_2", key: "coo", display_name: "Anchor", professional_role: "chief_operating_officer" },
    ],
    turns: over.turns ?? [],
    actionItems: over.actionItems ?? [],
  };
}

function memoryProviderStatus(over: Partial<MemoryProviderStatus> = {}): MemoryProviderStatus {
  return { kind: "obsidian", registered: true, ok: true, message: "Vault erreichbar.", ...over };
}

function memoryRef(over: Partial<MemoryRef> = {}): MemoryRef {
  return {
    id: "mem_1",
    company_id: "cmp_1",
    provider: "obsidian",
    external_id: "note/mem_1",
    kind: "note",
    title: "Backup policy",
    path: "IronCrew/note/mem_1.md",
    task_id: null,
    project_id: null,
    agent_id: null,
    source: "",
    confidence: 1,
    sensitivity: "internal",
    created_at: Date.now(),
    ...over,
  };
}

function notificationChannelStatus(over: Partial<NotificationChannelStatus> = {}): NotificationChannelStatus {
  return { kind: "discord", registered: true, ok: true, message: 'Webhook "IronCrew Alerts" erreichbar.', ...over };
}

function tailscaleInfo(over: Partial<TailscaleInfo> = {}): TailscaleInfo {
  return {
    backendState: "Running",
    self: {
      id: "1",
      hostName: "crew-server",
      dnsName: "crew-server.tailnet.ts.net.",
      tailscaleIPs: ["100.1.1.1"],
      online: true,
      os: "linux",
    },
    peers: [],
    ok: true,
    message: "verbunden als crew-server (100.1.1.1)",
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

describe("network (Tailscale/Headscale status + remote workers)", () => {
  it("shows this node's tailnet status and reachable peers", async () => {
    const client = makeClient({
      tailscale: vi.fn().mockResolvedValue(
        tailscaleInfo({
          peers: [
            {
              id: "2",
              hostName: "tier0-worker",
              dnsName: "tier0-worker.ts.net.",
              tailscaleIPs: ["100.1.1.2"],
              online: true,
              os: "linux",
            },
          ],
        }),
      ),
    });
    render(<CommandCenterView client={client} />);

    await userEvent.setup().click(await screen.findByTestId("open-network"));
    const dialog = await screen.findByRole("dialog", { name: "Netzwerk" });

    expect(await within(dialog).findByTestId("tailscale-self-status")).toHaveTextContent("crew-server");
    expect(within(dialog).getByTestId("tailscale-self-status")).toHaveTextContent("Running");
    expect(within(dialog).getByText("tier0-worker")).toBeInTheDocument();
  });

  it("lists registered remote workers, without ever rendering a private key", async () => {
    const client = makeClient({ remoteWorkers: vi.fn().mockResolvedValue({ remoteWorkers: [remoteWorker()] }) });
    render(<CommandCenterView client={client} />);

    await userEvent.setup().click(await screen.findByTestId("open-network"));
    const dialog = await screen.findByRole("dialog", { name: "Netzwerk" });

    expect(await within(dialog).findByText("tier0-acme")).toBeInTheDocument();
    expect(within(dialog).getByText("deploy@100.64.1.2:22")).toBeInTheDocument();
    expect(dialog.textContent).not.toMatch(/acme\.pem/);
  });

  it("registers a remote worker via the form and refreshes the list", async () => {
    const createRemoteWorker = vi.fn().mockResolvedValue({ remoteWorker: remoteWorker() });
    const client = makeClient({
      remoteWorkers: vi
        .fn()
        .mockResolvedValueOnce({ remoteWorkers: [] })
        .mockResolvedValue({ remoteWorkers: [remoteWorker()] }),
      createRemoteWorker,
    });
    render(<CommandCenterView client={client} />);

    await userEvent.setup().click(await screen.findByTestId("open-network"));
    const dialog = await screen.findByRole("dialog", { name: "Netzwerk" });

    const user = userEvent.setup();
    await user.type(within(dialog).getByTestId("new-worker-label"), "tier0-acme");
    await user.type(within(dialog).getByTestId("new-worker-host"), "100.64.1.2");
    await user.type(within(dialog).getByTestId("new-worker-ssh-user"), "deploy");
    await user.type(within(dialog).getByTestId("new-worker-key-path"), "/etc/ironcrew/keys/acme.pem");
    await user.click(within(dialog).getByTestId("new-worker-submit"));

    expect(createRemoteWorker).toHaveBeenCalledWith({
      label: "tier0-acme",
      environment: undefined,
      host: "100.64.1.2",
      sshUser: "deploy",
      privateKeyPath: "/etc/ironcrew/keys/acme.pem",
      knownHostsPolicy: "strict",
    });
    expect(await within(dialog).findByText("tier0-acme")).toBeInTheDocument();
  });

  it("tests a remote worker's reachability and shows the result", async () => {
    const testRemoteWorker = vi.fn().mockResolvedValue({ ok: false, message: "Nicht erreichbar über 100.64.1.2:22" });
    const client = makeClient({
      remoteWorkers: vi.fn().mockResolvedValue({ remoteWorkers: [remoteWorker()] }),
      testRemoteWorker,
    });
    render(<CommandCenterView client={client} />);

    await userEvent.setup().click(await screen.findByTestId("open-network"));
    const dialog = await screen.findByRole("dialog", { name: "Netzwerk" });
    await userEvent.setup().click(await within(dialog).findByRole("button", { name: "Testen" }));

    expect(testRemoteWorker).toHaveBeenCalledWith("worker_1");
    expect(await within(dialog).findByTestId("remote-worker-test-worker_1")).toHaveTextContent(
      "Nicht erreichbar über 100.64.1.2:22",
    );
  });

  it("deletes a remote worker", async () => {
    const deleteRemoteWorker = vi.fn().mockResolvedValue({ ok: true });
    const client = makeClient({
      remoteWorkers: vi
        .fn()
        .mockResolvedValueOnce({ remoteWorkers: [remoteWorker()] })
        .mockResolvedValue({ remoteWorkers: [] }),
      deleteRemoteWorker,
    });
    render(<CommandCenterView client={client} />);

    await userEvent.setup().click(await screen.findByTestId("open-network"));
    const dialog = await screen.findByRole("dialog", { name: "Netzwerk" });
    await userEvent.setup().click(await within(dialog).findByRole("button", { name: "Entfernen" }));

    expect(deleteRemoteWorker).toHaveBeenCalledWith("worker_1");
    await waitFor(() => expect(within(dialog).queryByText("tier0-acme")).toBeNull());
  });
});

describe("meetings (moderator, bounded rounds, budget)", () => {
  function twoAgentsClient(over: Partial<Record<keyof Client, unknown>> = {}) {
    return makeClient({
      agents: vi.fn().mockResolvedValue({
        agents: [agent({ id: "agt_1", displayName: "Forge" }), agent({ id: "agt_2", displayName: "Anchor" })],
      }),
      ...over,
    });
  }

  it("lists meetings and their round progress", async () => {
    const client = twoAgentsClient({
      meetings: vi.fn().mockResolvedValue({ meetings: [meeting({ status: "in_progress", current_round: 2 })] }),
    });
    render(<CommandCenterView client={client} />);

    await userEvent.setup().click(await screen.findByTestId("open-meetings"));
    const dialog = await screen.findByRole("dialog", { name: "Meetings" });

    expect(await within(dialog).findByText("Sprint-Planung")).toBeInTheDocument();
    expect(within(dialog).getByText("Runde 2/6")).toBeInTheDocument();
  });

  it("creates a meeting via the form with selected moderator and participants", async () => {
    const createMeeting = vi.fn().mockResolvedValue({ meeting: meeting() });
    const client = twoAgentsClient({
      meetings: vi
        .fn()
        .mockResolvedValueOnce({ meetings: [] })
        .mockResolvedValue({ meetings: [meeting()] }),
      createMeeting,
    });
    render(<CommandCenterView client={client} />);

    await userEvent.setup().click(await screen.findByTestId("open-meetings"));
    const dialog = await screen.findByRole("dialog", { name: "Meetings" });

    const user = userEvent.setup();
    await user.type(within(dialog).getByTestId("new-meeting-topic"), "Sprint-Planung");
    await user.selectOptions(within(dialog).getByTestId("new-meeting-moderator"), "agt_1");
    await user.click(within(dialog).getByTestId("new-meeting-participant-agt_2"));
    await user.click(within(dialog).getByTestId("new-meeting-submit"));

    expect(createMeeting).toHaveBeenCalledWith({
      topic: "Sprint-Planung",
      moderatorAgentId: "agt_1",
      participantAgentIds: ["agt_2"],
      maxRounds: 6,
    });
    expect(await within(dialog).findByText("Sprint-Planung")).toBeInTheDocument();
  });

  it("opens a meeting, starts it, and runs the next turn", async () => {
    const startMeeting = vi.fn().mockResolvedValue({ meeting: meeting({ status: "in_progress" }) });
    const nextMeetingTurn = vi.fn().mockResolvedValue({
      meeting: meeting({ status: "in_progress", current_round: 1 }),
      turn: {
        id: "turn_1",
        meeting_id: "mtg_1",
        round: 1,
        agent_id: "agt_1",
        contribution: "Ich schlage vor, mit dem Backend zu starten.",
        cost_micros: 0,
        created_at: Date.now(),
      },
    });
    const client = twoAgentsClient({
      meetings: vi.fn().mockResolvedValue({ meetings: [meeting()] }),
      meeting: vi
        .fn()
        .mockResolvedValueOnce(meetingDetail())
        .mockResolvedValueOnce(meetingDetail({ meeting: { status: "in_progress" } }))
        .mockResolvedValue(
          meetingDetail({
            meeting: { status: "in_progress", current_round: 1 },
            turns: [
              {
                id: "turn_1",
                meeting_id: "mtg_1",
                round: 1,
                agent_id: "agt_1",
                contribution: "Ich schlage vor, mit dem Backend zu starten.",
                cost_micros: 0,
                created_at: Date.now(),
              },
            ],
          }),
        ),
      startMeeting,
      nextMeetingTurn,
    });
    render(<CommandCenterView client={client} />);

    await userEvent.setup().click(await screen.findByTestId("open-meetings"));
    const listDialog = await screen.findByRole("dialog", { name: "Meetings" });
    await userEvent.setup().click(await within(listDialog).findByRole("button", { name: "Öffnen" }));

    const detailDialog = await screen.findByRole("dialog", { name: "Sprint-Planung" });
    await userEvent.setup().click(within(detailDialog).getByTestId("meeting-start"));
    expect(startMeeting).toHaveBeenCalledWith("mtg_1");

    await userEvent.setup().click(await within(detailDialog).findByTestId("meeting-next-turn"));
    expect(nextMeetingTurn).toHaveBeenCalledWith("mtg_1", undefined);
    expect(await within(detailDialog).findByText("Ich schlage vor, mit dem Backend zu starten.")).toBeInTheDocument();
  });

  it("ends a meeting with minutes typed into the form", async () => {
    const endMeeting = vi.fn().mockResolvedValue({ meeting: meeting({ status: "completed" }) });
    const client = twoAgentsClient({
      meetings: vi.fn().mockResolvedValue({ meetings: [meeting({ status: "in_progress" })] }),
      meeting: vi.fn().mockResolvedValue(meetingDetail({ meeting: { status: "in_progress" } })),
      endMeeting,
    });
    render(<CommandCenterView client={client} />);

    await userEvent.setup().click(await screen.findByTestId("open-meetings"));
    const listDialog = await screen.findByRole("dialog", { name: "Meetings" });
    await userEvent.setup().click(await within(listDialog).findByRole("button", { name: "Öffnen" }));
    const detailDialog = await screen.findByRole("dialog", { name: "Sprint-Planung" });

    const user = userEvent.setup();
    await user.type(within(detailDialog).getByTestId("meeting-minutes"), "Ergebnis: weiter wie geplant.");
    await user.click(within(detailDialog).getByTestId("meeting-end"));

    expect(endMeeting).toHaveBeenCalledWith("mtg_1", "Ergebnis: weiter wie geplant.");
  });

  it("cancels a meeting", async () => {
    const cancelMeeting = vi.fn().mockResolvedValue({ meeting: meeting({ status: "cancelled" }) });
    const client = twoAgentsClient({
      meetings: vi.fn().mockResolvedValue({ meetings: [meeting()] }),
      meeting: vi.fn().mockResolvedValue(meetingDetail()),
      cancelMeeting,
    });
    render(<CommandCenterView client={client} />);

    await userEvent.setup().click(await screen.findByTestId("open-meetings"));
    const listDialog = await screen.findByRole("dialog", { name: "Meetings" });
    await userEvent.setup().click(await within(listDialog).findByRole("button", { name: "Öffnen" }));
    const detailDialog = await screen.findByRole("dialog", { name: "Sprint-Planung" });

    await userEvent.setup().click(within(detailDialog).getByTestId("meeting-cancel"));
    expect(cancelMeeting).toHaveBeenCalledWith("mtg_1");
  });

  it("adds an action item and converts it into a real task", async () => {
    const addMeetingActionItem = vi.fn().mockResolvedValue({
      actionItem: {
        id: "action_1",
        meeting_id: "mtg_1",
        description: "Angebot nachfassen",
        assigned_agent_id: null,
        task_id: null,
        created_at: Date.now(),
      },
    });
    const convertActionItemToTask = vi.fn().mockResolvedValue({ task: task({ id: "task_9" }) });
    const client = twoAgentsClient({
      meetings: vi.fn().mockResolvedValue({ meetings: [meeting()] }),
      meeting: vi
        .fn()
        .mockResolvedValueOnce(meetingDetail())
        .mockResolvedValueOnce(
          meetingDetail({
            actionItems: [
              {
                id: "action_1",
                meeting_id: "mtg_1",
                description: "Angebot nachfassen",
                assigned_agent_id: null,
                task_id: null,
                created_at: Date.now(),
              },
            ],
          }),
        )
        .mockResolvedValue(
          meetingDetail({
            actionItems: [
              {
                id: "action_1",
                meeting_id: "mtg_1",
                description: "Angebot nachfassen",
                assigned_agent_id: null,
                task_id: "task_9",
                created_at: Date.now(),
              },
            ],
          }),
        ),
      addMeetingActionItem,
      convertActionItemToTask,
    });
    render(<CommandCenterView client={client} />);

    await userEvent.setup().click(await screen.findByTestId("open-meetings"));
    const listDialog = await screen.findByRole("dialog", { name: "Meetings" });
    await userEvent.setup().click(await within(listDialog).findByRole("button", { name: "Öffnen" }));
    const detailDialog = await screen.findByRole("dialog", { name: "Sprint-Planung" });

    const user = userEvent.setup();
    await user.type(within(detailDialog).getByTestId("new-action-item-description"), "Angebot nachfassen");
    await user.click(within(detailDialog).getByTestId("new-action-item-submit"));
    expect(addMeetingActionItem).toHaveBeenCalledWith("mtg_1", {
      description: "Angebot nachfassen",
      assignedAgentId: undefined,
    });

    await userEvent.setup().click(await within(detailDialog).findByRole("button", { name: "Als Aufgabe anlegen" }));
    expect(convertActionItemToTask).toHaveBeenCalledWith("action_1");
    expect(await within(detailDialog).findByText("Aufgabe angelegt")).toBeInTheDocument();
  });
});

describe("memory (Obsidian vault, the first MemoryProvider)", () => {
  it("shows provider status and recorded entries", async () => {
    const client = makeClient({
      memoryProviders: vi.fn().mockResolvedValue({ providers: [memoryProviderStatus()] }),
      memories: vi.fn().mockResolvedValue({ memories: [memoryRef()] }),
    });
    render(<CommandCenterView client={client} />);

    await userEvent.setup().click(await screen.findByTestId("open-memory"));
    const dialog = await screen.findByRole("dialog", { name: "Wissen" });

    expect(await within(dialog).findByTestId("memory-provider-obsidian")).toHaveTextContent("verbunden");
    expect(within(dialog).getByText("Backup policy")).toBeInTheDocument();
  });

  it("records a new note via the form", async () => {
    const recordMemory = vi.fn().mockResolvedValue({ memory: memoryRef() });
    const client = makeClient({
      memoryProviders: vi.fn().mockResolvedValue({ providers: [memoryProviderStatus()] }),
      memories: vi
        .fn()
        .mockResolvedValueOnce({ memories: [] })
        .mockResolvedValue({ memories: [memoryRef()] }),
      recordMemory,
    });
    render(<CommandCenterView client={client} />);

    await userEvent.setup().click(await screen.findByTestId("open-memory"));
    const dialog = await screen.findByRole("dialog", { name: "Wissen" });

    const user = userEvent.setup();
    await user.type(within(dialog).getByTestId("new-memory-title"), "Backup policy");
    await user.type(within(dialog).getByTestId("new-memory-content"), "Nightly backups run at 02:00 UTC.");
    await user.click(within(dialog).getByTestId("new-memory-submit"));

    expect(recordMemory).toHaveBeenCalledWith({
      provider: "obsidian",
      kind: "note",
      title: "Backup policy",
      content: "Nightly backups run at 02:00 UTC.",
    });
    expect(await within(dialog).findByText("Backup policy")).toBeInTheDocument();
  });

  it("opens an entry's live content and closes it again", async () => {
    const memoryContent = vi
      .fn()
      .mockResolvedValue({ memory: memoryRef(), content: "Nightly backups run at 02:00 UTC." });
    const client = makeClient({
      memoryProviders: vi.fn().mockResolvedValue({ providers: [memoryProviderStatus()] }),
      memories: vi.fn().mockResolvedValue({ memories: [memoryRef()] }),
      memoryContent,
    });
    render(<CommandCenterView client={client} />);

    await userEvent.setup().click(await screen.findByTestId("open-memory"));
    const dialog = await screen.findByRole("dialog", { name: "Wissen" });
    await userEvent.setup().click(within(dialog).getByRole("button", { name: "Öffnen" }));

    expect(memoryContent).toHaveBeenCalledWith("mem_1");
    const detail = await within(dialog).findByTestId("memory-detail");
    expect(detail).toHaveTextContent("Nightly backups run at 02:00 UTC.");

    await userEvent.setup().click(within(detail).getByRole("button", { name: "Schließen" }));
    expect(within(dialog).queryByTestId("memory-detail")).toBeNull();
  });

  it("deletes an entry", async () => {
    const deleteMemory = vi.fn().mockResolvedValue({ ok: true });
    const client = makeClient({
      memoryProviders: vi.fn().mockResolvedValue({ providers: [memoryProviderStatus()] }),
      memories: vi
        .fn()
        .mockResolvedValueOnce({ memories: [memoryRef()] })
        .mockResolvedValue({ memories: [] }),
      deleteMemory,
    });
    render(<CommandCenterView client={client} />);

    await userEvent.setup().click(await screen.findByTestId("open-memory"));
    const dialog = await screen.findByRole("dialog", { name: "Wissen" });
    await userEvent.setup().click(within(dialog).getByRole("button", { name: "Löschen" }));

    expect(deleteMemory).toHaveBeenCalledWith("mem_1");
    await waitFor(() => expect(within(dialog).queryByText("Backup policy")).toBeNull());
  });

  it("searches the vault and shows results", async () => {
    const searchMemory = vi.fn().mockResolvedValue({
      hits: [
        { externalId: "note/mem_1", title: "Backup policy", snippet: "…nightly…", path: "IronCrew/note/mem_1.md" },
      ],
    });
    const client = makeClient({
      memoryProviders: vi.fn().mockResolvedValue({ providers: [memoryProviderStatus()] }),
      searchMemory,
    });
    render(<CommandCenterView client={client} />);

    await userEvent.setup().click(await screen.findByTestId("open-memory"));
    const dialog = await screen.findByRole("dialog", { name: "Wissen" });

    const user = userEvent.setup();
    await user.type(within(dialog).getByTestId("memory-search-input"), "nightly");
    await user.click(within(dialog).getByTestId("memory-search-submit"));

    expect(searchMemory).toHaveBeenCalledWith("obsidian", "nightly");
    expect(await within(dialog).findByTestId("memory-search-results")).toHaveTextContent("Backup policy");
  });
});

describe("notification channels (Discord, Telegram, email fan-out)", () => {
  it("shows registered channels with their status", async () => {
    const client = makeClient({
      notificationChannels: vi.fn().mockResolvedValue({ channels: [notificationChannelStatus()] }),
    });
    render(<CommandCenterView client={client} />);

    await userEvent.setup().click(await screen.findByTestId("open-channels"));
    const dialog = await screen.findByRole("dialog", { name: "Kanäle" });

    expect(await within(dialog).findByTestId("channel-discord")).toHaveTextContent("Discord");
    expect(within(dialog).getByTestId("channel-discord")).toHaveTextContent("verbunden");
  });

  it("tests a channel's reachability and shows the result", async () => {
    const testNotificationChannel = vi
      .fn()
      .mockResolvedValue({ ok: false, message: "Discord-Webhook antwortet mit 401." });
    const client = makeClient({
      notificationChannels: vi.fn().mockResolvedValue({ channels: [notificationChannelStatus()] }),
      testNotificationChannel,
    });
    render(<CommandCenterView client={client} />);

    await userEvent.setup().click(await screen.findByTestId("open-channels"));
    const dialog = await screen.findByRole("dialog", { name: "Kanäle" });
    await userEvent.setup().click(await within(dialog).findByRole("button", { name: "Testen" }));

    expect(testNotificationChannel).toHaveBeenCalledWith("discord");
    expect(await within(dialog).findByTestId("channel-test-discord")).toHaveTextContent(
      "Discord-Webhook antwortet mit 401.",
    );
  });

  it("sends a real test notification through a channel", async () => {
    const sendTestNotification = vi.fn().mockResolvedValue({ ok: true, message: "Testbenachrichtigung gesendet." });
    const client = makeClient({
      notificationChannels: vi.fn().mockResolvedValue({ channels: [notificationChannelStatus({ kind: "telegram" })] }),
      sendTestNotification,
    });
    render(<CommandCenterView client={client} />);

    await userEvent.setup().click(await screen.findByTestId("open-channels"));
    const dialog = await screen.findByRole("dialog", { name: "Kanäle" });
    await userEvent.setup().click(await within(dialog).findByRole("button", { name: "Testnachricht senden" }));

    expect(sendTestNotification).toHaveBeenCalledWith("telegram");
    expect(await within(dialog).findByTestId("channel-test-telegram")).toHaveTextContent(
      "Testbenachrichtigung gesendet.",
    );
  });

  it("shows an empty state when nothing is registered", async () => {
    const client = makeClient();
    render(<CommandCenterView client={client} />);

    await userEvent.setup().click(await screen.findByTestId("open-channels"));
    const dialog = await screen.findByRole("dialog", { name: "Kanäle" });
    expect(await within(dialog).findByText("Kein Kanal registriert.")).toBeInTheDocument();
  });
});

function mailbox(over: Partial<Mailbox> = {}): Mailbox {
  return {
    id: "mbx_1",
    company_id: "cmp_1",
    label: "Support",
    kind: "imap",
    email_address: "support@example.com",
    host: "imap.example.com",
    port: 993,
    use_tls: 1,
    username: "support",
    smtp_host: "smtp.example.com",
    smtp_port: 587,
    session_url: "",
    tenant_id: "",
    client_id: "",
    poll_enabled: 0,
    poll_interval_seconds: 300,
    auto_triage: 0,
    last_polled_at: null,
    last_error: "",
    created_at: Date.now(),
    updated_at: Date.now(),
    agents: [],
    ...over,
  };
}

function mailMessage(over: Partial<MailMessage> = {}): MailMessage {
  return {
    externalId: "42",
    messageId: "<m1@example.com>",
    subject: "Server down",
    from: "kunde@example.com",
    to: ["support@example.com"],
    receivedAt: Date.now(),
    snippet: "Nichts geht mehr.",
    unread: true,
    ...over,
  };
}

describe("mailboxes (IMAP/JMAP/M365/Gmail with per-agent grants)", () => {
  it("lists mailboxes with their protocol and address", async () => {
    const client = makeClient({ mailboxes: vi.fn().mockResolvedValue({ mailboxes: [mailbox()] }) });
    render(<CommandCenterView client={client} />);

    await userEvent.setup().click(await screen.findByTestId("open-mailboxes"));
    const dialog = await screen.findByRole("dialog", { name: "E-Mail-Postfächer" });

    const row = await within(dialog).findByTestId("mailbox-mbx_1");
    expect(row).toHaveTextContent("Support");
    expect(row).toHaveTextContent("IMAP");
    expect(row).toHaveTextContent("support@example.com");
  });

  it("shows an empty state when no mailbox is connected", async () => {
    render(<CommandCenterView client={makeClient()} />);

    await userEvent.setup().click(await screen.findByTestId("open-mailboxes"));
    const dialog = await screen.findByRole("dialog", { name: "E-Mail-Postfächer" });
    expect(await within(dialog).findByText("Kein Postfach angebunden.")).toBeInTheDocument();
  });

  it("only asks for the fields the chosen protocol needs", async () => {
    render(<CommandCenterView client={makeClient()} />);
    const user = userEvent.setup();

    await user.click(await screen.findByTestId("open-mailboxes"));
    const dialog = await screen.findByRole("dialog", { name: "E-Mail-Postfächer" });

    expect(await within(dialog).findByTestId("new-mailbox-host")).toBeInTheDocument();
    expect(within(dialog).queryByTestId("new-mailbox-session-url")).not.toBeInTheDocument();

    await user.selectOptions(within(dialog).getByTestId("new-mailbox-kind"), "jmap");
    expect(within(dialog).queryByTestId("new-mailbox-host")).not.toBeInTheDocument();
    expect(within(dialog).getByTestId("new-mailbox-session-url")).toBeInTheDocument();

    await user.selectOptions(within(dialog).getByTestId("new-mailbox-kind"), "m365");
    expect(within(dialog).getByTestId("new-mailbox-tenant-id")).toBeInTheDocument();
    expect(within(dialog).getByTestId("new-mailbox-client-id")).toBeInTheDocument();
  });

  it("connects a new IMAP mailbox with its credentials", async () => {
    const createMailbox = vi.fn().mockResolvedValue({ mailbox: mailbox() });
    const client = makeClient({ createMailbox });
    render(<CommandCenterView client={client} />);
    const user = userEvent.setup();

    await user.click(await screen.findByTestId("open-mailboxes"));
    const dialog = await screen.findByRole("dialog", { name: "E-Mail-Postfächer" });

    await user.type(await within(dialog).findByTestId("new-mailbox-label"), "Support");
    await user.type(within(dialog).getByTestId("new-mailbox-address"), "support@example.com");
    await user.type(within(dialog).getByTestId("new-mailbox-host"), "imap.example.com");
    await user.type(within(dialog).getByTestId("new-mailbox-username"), "support");
    await user.type(within(dialog).getByTestId("new-mailbox-secret"), "hunter2");
    await user.click(within(dialog).getByTestId("new-mailbox-submit"));

    expect(createMailbox).toHaveBeenCalledWith(
      expect.objectContaining({
        label: "Support",
        kind: "imap",
        emailAddress: "support@example.com",
        host: "imap.example.com",
        username: "support",
        credentials: { password: "hunter2" },
      }),
    );
  });

  it("cannot arm auto-triage without polling", async () => {
    render(<CommandCenterView client={makeClient()} />);

    await userEvent.setup().click(await screen.findByTestId("open-mailboxes"));
    const dialog = await screen.findByRole("dialog", { name: "E-Mail-Postfächer" });

    // The schema refuses this combination; the form must not offer it either.
    expect(await within(dialog).findByTestId("new-mailbox-triage")).toBeDisabled();
    await userEvent.setup().click(within(dialog).getByTestId("new-mailbox-poll"));
    expect(within(dialog).getByTestId("new-mailbox-triage")).toBeEnabled();
  });

  it("switching polling off takes auto-triage with it", async () => {
    const updateMailbox = vi.fn().mockResolvedValue({ mailbox: mailbox() });
    const client = makeClient({
      mailboxes: vi.fn().mockResolvedValue({ mailboxes: [mailbox({ poll_enabled: 1, auto_triage: 1 })] }),
      updateMailbox,
    });
    render(<CommandCenterView client={client} />);

    await userEvent.setup().click(await screen.findByTestId("open-mailboxes"));
    const dialog = await screen.findByRole("dialog", { name: "E-Mail-Postfächer" });
    await userEvent.setup().click(await within(dialog).findByTestId("mailbox-poll-mbx_1"));

    expect(updateMailbox).toHaveBeenCalledWith("mbx_1", { pollEnabled: false, autoTriage: false });
  });

  it("grants an agent access to a mailbox and shows the grant", async () => {
    const grantMailboxAgent = vi.fn().mockResolvedValue({ agents: [] });
    const client = makeClient({
      mailboxes: vi.fn().mockResolvedValue({ mailboxes: [mailbox()] }),
      grantMailboxAgent,
    });
    render(<CommandCenterView client={client} />);
    const user = userEvent.setup();

    await user.click(await screen.findByTestId("open-mailboxes"));
    const dialog = await screen.findByRole("dialog", { name: "E-Mail-Postfächer" });

    expect(await within(dialog).findByTestId("mailbox-agents-empty-mbx_1")).toBeInTheDocument();
    await user.selectOptions(within(dialog).getByTestId("mailbox-grant-agent-mbx_1"), "agt_1");
    await user.selectOptions(within(dialog).getByTestId("mailbox-grant-access-mbx_1"), "send");
    await user.click(within(dialog).getByTestId("mailbox-grant-submit-mbx_1"));

    expect(grantMailboxAgent).toHaveBeenCalledWith("mbx_1", "agt_1", "send");
  });

  it("shows the agents that may work a mailbox and can revoke one", async () => {
    const revokeMailboxAgent = vi.fn().mockResolvedValue({ agents: [] });
    const client = makeClient({
      mailboxes: vi.fn().mockResolvedValue({
        mailboxes: [
          mailbox({
            agents: [{ agent_id: "agt_1", key: "cto", display_name: "Forge", access: "send", granted_at: Date.now() }],
          }),
        ],
      }),
      revokeMailboxAgent,
    });
    render(<CommandCenterView client={client} />);

    await userEvent.setup().click(await screen.findByTestId("open-mailboxes"));
    const dialog = await screen.findByRole("dialog", { name: "E-Mail-Postfächer" });

    const grant = await within(dialog).findByTestId("mailbox-agent-mbx_1-agt_1");
    expect(grant).toHaveTextContent("Forge");
    expect(grant).toHaveTextContent("Lesen + Senden");

    await userEvent.setup().click(within(grant).getByRole("button", { name: "Entziehen" }));
    expect(revokeMailboxAgent).toHaveBeenCalledWith("mbx_1", "agt_1");
  });

  it("loads live messages for a mailbox", async () => {
    const mailboxMessages = vi.fn().mockResolvedValue({ messages: [mailMessage()] });
    const client = makeClient({
      mailboxes: vi.fn().mockResolvedValue({ mailboxes: [mailbox()] }),
      mailboxMessages,
    });
    render(<CommandCenterView client={client} />);

    await userEvent.setup().click(await screen.findByTestId("open-mailboxes"));
    const dialog = await screen.findByRole("dialog", { name: "E-Mail-Postfächer" });
    await userEvent.setup().click(await within(dialog).findByTestId("mailbox-messages-mbx_1"));

    expect(mailboxMessages).toHaveBeenCalledWith("mbx_1");
    const message = await within(dialog).findByTestId("mail-message-42");
    expect(message).toHaveTextContent("Server down");
    expect(message).toHaveTextContent("kunde@example.com");
  });

  it("polls a mailbox on demand and reports what the triage created", async () => {
    const pollMailbox = vi.fn().mockResolvedValue({ mailbox: mailbox(), seen: 3, newMessages: 2, tasksCreated: 1 });
    const client = makeClient({
      mailboxes: vi.fn().mockResolvedValue({ mailboxes: [mailbox({ poll_enabled: 1 })] }),
      pollMailbox,
    });
    render(<CommandCenterView client={client} />);

    await userEvent.setup().click(await screen.findByTestId("open-mailboxes"));
    const dialog = await screen.findByRole("dialog", { name: "E-Mail-Postfächer" });
    await userEvent.setup().click(await within(dialog).findByTestId("mailbox-poll-now-mbx_1"));

    expect(pollMailbox).toHaveBeenCalledWith("mbx_1");
    expect(await within(dialog).findByTestId("mailbox-test-mbx_1")).toHaveTextContent("2 neu, 1 Aufgabe");
  });

  it("surfaces the last connection error of a mailbox", async () => {
    const client = makeClient({
      mailboxes: vi.fn().mockResolvedValue({ mailboxes: [mailbox({ last_error: "IMAP: LOGIN failed." })] }),
    });
    render(<CommandCenterView client={client} />);

    await userEvent.setup().click(await screen.findByTestId("open-mailboxes"));
    const dialog = await screen.findByRole("dialog", { name: "E-Mail-Postfächer" });
    expect(await within(dialog).findByTestId("mailbox-error-mbx_1")).toHaveTextContent("IMAP: LOGIN failed.");
  });

  it("shows which mail protocols the server actually has a provider for", async () => {
    const client = makeClient({
      mailProviders: vi.fn().mockResolvedValue({
        providers: [
          { kind: "imap", registered: true },
          { kind: "gmail", registered: false },
        ],
      }),
    });
    render(<CommandCenterView client={client} />);

    await userEvent.setup().click(await screen.findByTestId("open-mailboxes"));
    const dialog = await screen.findByRole("dialog", { name: "E-Mail-Postfächer" });

    expect(await within(dialog).findByTestId("mail-provider-imap")).toHaveTextContent("verfügbar");
    expect(within(dialog).getByTestId("mail-provider-gmail")).toHaveTextContent("nicht registriert");
  });
});
