/**
 * IronCrew — Command Center.
 *
 * A cinematic HUD built from accessible DOM, not a canvas. Everything here is
 * real backend state: agent status is derived server-side from the work an
 * agent actually holds, so a figure can never disagree with the control plane.
 *
 * There are no placeholder KPIs. Every figure comes from /api/crew/dashboard,
 * which reports its own source and read time.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./command-center.css";
import { api } from "./api.ts";
import {
  AGENT_STATUS_LABEL,
  BOARD_COLUMNS,
  MEETING_STATUS_LABEL,
  MEMORY_KIND_LABEL,
  MILESTONE_STATUS_LABEL,
  NOTIFICATION_CHANNEL_LABEL,
  NOTIFICATION_SEVERITY_LABEL,
  PROJECT_STATUS_LABEL,
  SECRET_PROVIDER_LABEL,
  TASK_STATUS_LABEL,
  type Agent,
  type Approval,
  type Attachment,
  type Dashboard,
  type Decision,
  type Department,
  type Goal,
  type KnownHostsPolicy,
  type Meeting,
  type MeetingActionItem,
  type MeetingParticipant,
  type MeetingTurn,
  type MemoryKind,
  type MemoryProviderStatus,
  type MemoryRef,
  type MemorySearchHit,
  type Message,
  type Milestone,
  type Notification,
  type NotificationChannelStatus,
  type Project,
  type RemoteWorker,
  type RunEvent,
  type RuntimeInfo,
  type Secret,
  type SecretProviderKind,
  type SecretProviderStatus,
  type TailscaleInfo,
  type Task,
  type TaskStatus,
} from "./types.ts";

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Reads a File as base64 (without the data: URL prefix), for the JSON upload body. */
function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("could not read file"));
        return;
      }
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("could not read file"));
    reader.readAsDataURL(file);
  });
}

function eventKind(type: string): "error" | "decision" | "normal" {
  if (type === "run.failed" || type === "tool.failed" || type === "run.cancelled") return "error";
  if (type === "approval.required" || type === "rate_limit.detected" || type === "run.waiting") return "decision";
  return "normal";
}

export interface CommandCenterViewProps {
  /** Injected in tests; defaults to the live REST client. */
  client?: typeof api;
}

export function CommandCenterView({ client = api }: CommandCenterViewProps): React.JSX.Element {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [companyName, setCompanyName] = useState("IronCrew");
  const [runtimes, setRuntimes] = useState<RuntimeInfo[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [showOrgChart, setShowOrgChart] = useState(false);

  const [secrets, setSecrets] = useState<Secret[]>([]);
  const [secretProviders, setSecretProviders] = useState<SecretProviderStatus[]>([]);
  const [showSecrets, setShowSecrets] = useState(false);
  const [secretTestResults, setSecretTestResults] = useState<Record<string, { ok: boolean; message: string }>>({});
  const [newSecretName, setNewSecretName] = useState("");
  const [newSecretProvider, setNewSecretProvider] = useState<SecretProviderKind>("vaultwarden");
  const [newSecretItemRef, setNewSecretItemRef] = useState("");
  const [newSecretField, setNewSecretField] = useState("");

  const [generalAttachments, setGeneralAttachments] = useState<Attachment[]>([]);
  const [showDocuments, setShowDocuments] = useState(false);

  const [tailscaleInfo, setTailscaleInfo] = useState<TailscaleInfo | null>(null);
  const [remoteWorkers, setRemoteWorkers] = useState<RemoteWorker[]>([]);
  const [showNetwork, setShowNetwork] = useState(false);
  const [remoteWorkerTestResults, setRemoteWorkerTestResults] = useState<
    Record<string, { ok: boolean; message: string }>
  >({});
  const [newWorkerLabel, setNewWorkerLabel] = useState("");
  const [newWorkerEnvironment, setNewWorkerEnvironment] = useState("");
  const [newWorkerHost, setNewWorkerHost] = useState("");
  const [newWorkerSshUser, setNewWorkerSshUser] = useState("");
  const [newWorkerPrivateKeyPath, setNewWorkerPrivateKeyPath] = useState("");
  const [newWorkerKnownHosts, setNewWorkerKnownHosts] = useState<KnownHostsPolicy>("strict");

  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [showMeetings, setShowMeetings] = useState(false);
  const [meetingDetail, setMeetingDetail] = useState<{
    meeting: Meeting;
    participants: MeetingParticipant[];
    turns: MeetingTurn[];
    actionItems: MeetingActionItem[];
  } | null>(null);
  const [newMeetingTopic, setNewMeetingTopic] = useState("");
  const [newMeetingModeratorId, setNewMeetingModeratorId] = useState("");
  const [newMeetingParticipantIds, setNewMeetingParticipantIds] = useState<string[]>([]);
  const [newMeetingMaxRounds, setNewMeetingMaxRounds] = useState(6);
  const [newActionItemDescription, setNewActionItemDescription] = useState("");
  const [newActionItemAssigneeId, setNewActionItemAssigneeId] = useState("");
  const [meetingMinutesDraft, setMeetingMinutesDraft] = useState("");

  const [memoryProviders, setMemoryProviders] = useState<MemoryProviderStatus[]>([]);
  const [memories, setMemories] = useState<MemoryRef[]>([]);
  const [showMemory, setShowMemory] = useState(false);
  const [memoryQuery, setMemoryQuery] = useState("");
  const [memorySearchHits, setMemorySearchHits] = useState<MemorySearchHit[] | null>(null);
  const [memoryDetail, setMemoryDetail] = useState<{ memory: MemoryRef; content: string } | null>(null);
  const [newMemoryKind, setNewMemoryKind] = useState<MemoryKind>("note");
  const [newMemoryTitle, setNewMemoryTitle] = useState("");
  const [newMemoryContent, setNewMemoryContent] = useState("");

  const [notificationChannels, setNotificationChannels] = useState<NotificationChannelStatus[]>([]);
  const [showChannels, setShowChannels] = useState(false);
  const [channelTestResults, setChannelTestResults] = useState<Record<string, { ok: boolean; message: string }>>({});

  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null);
  const [showProjectList, setShowProjectList] = useState(false);
  const [showInbox, setShowInbox] = useState(false);
  const [projectDetail, setProjectDetail] = useState<{
    project: Project;
    milestones: Milestone[];
    tasks: Task[];
  } | null>(null);
  const [projectGoalAncestry, setProjectGoalAncestry] = useState<Goal[] | null>(null);

  const logRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try {
      const [a, t, c, ap, d, p, n, dec] = await Promise.all([
        client.agents(),
        client.tasks(),
        client.chat(),
        client.approvals(),
        client.dashboard(),
        client.projects(),
        client.notifications(),
        client.decisions(),
      ]);
      setAgents(a.agents);
      setTasks(t.tasks);
      setMessages(c.messages);
      setApprovals(ap.approvals);
      setDashboard(d);
      setProjects(p.projects);
      setNotifications(n.notifications);
      setUnreadCount(n.unreadCount);
      setDecisions(dec.decisions);
      setError(null);
    } catch (err) {
      // Never fail silently — an unreachable control plane is information.
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [client]);

  // Attachments are not in the plain `tasks`/project-detail payloads — they
  // need their own fetch, declared early so both the task- and
  // project-detail openers below can load them on open.
  const [taskAttachments, setTaskAttachments] = useState<Attachment[]>([]);
  const [projectAttachments, setProjectAttachments] = useState<Attachment[]>([]);

  const refreshTaskAttachments = useCallback(
    async (taskId: string) => {
      const { attachments } = await client.attachmentsForTask(taskId);
      setTaskAttachments(attachments);
    },
    [client],
  );

  const refreshProjectAttachments = useCallback(
    async (projectId: string) => {
      const { attachments } = await client.attachmentsForProject(projectId);
      setProjectAttachments(attachments);
    },
    [client],
  );

  const openProjectDetail = useCallback(
    async (projectId: string) => {
      setShowProjectList(false);
      try {
        const detail = await client.project(projectId);
        setProjectDetail(detail);
        setProjectGoalAncestry(null);
        void refreshProjectAttachments(projectId);
        if (detail.project.goal_id) {
          // Best-effort: the detail dialog still works without the goal
          // breadcrumb if this second call fails.
          client
            .goal(detail.project.goal_id)
            .then((g) => setProjectGoalAncestry(g.ancestry))
            .catch(() => setProjectGoalAncestry(null));
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [client, refreshProjectAttachments],
  );

  const closeProjectDetail = useCallback(() => {
    setProjectDetail(null);
    setProjectGoalAncestry(null);
  }, []);

  const refreshProjectDetail = useCallback(async () => {
    if (!projectDetail) return;
    const detail = await client.project(projectDetail.project.id);
    setProjectDetail(detail);
  }, [client, projectDetail]);

  // Blocking/blocked-by are not in the plain `tasks` list — they need their
  // own fetch, same shape as the project-detail pattern above.
  const [taskBlockers, setTaskBlockers] = useState<Task[]>([]);
  const [taskBlocking, setTaskBlocking] = useState<Task[]>([]);
  const [addBlockerId, setAddBlockerId] = useState("");

  const refreshTaskDependencies = useCallback(
    async (taskId: string) => {
      try {
        const detail = await client.task(taskId);
        setTaskBlockers(detail.blockers);
        setTaskBlocking(detail.blocking);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [client],
  );

  const openTaskDetail = useCallback(
    (t: Task) => {
      setSelectedTask(t);
      setAddBlockerId("");
      void refreshTaskDependencies(t.id);
      void refreshTaskAttachments(t.id);
    },
    [refreshTaskDependencies, refreshTaskAttachments],
  );

  // Provider Health: kept separate from refresh() — each registered runtime
  // probes its own CLI (e.g. `claude --version`), so this is refreshed on
  // demand from the agent-detail dialog rather than on every poll.
  const refreshRuntimes = useCallback(async () => {
    try {
      const { runtimes: r } = await client.runtimes();
      setRuntimes(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [client]);

  // Shared by the roster and the org chart — the same agent-detail dialog
  // opens from either place.
  const openAgentDetail = useCallback(
    (agent: Agent) => {
      setSelectedAgent(agent);
      void refreshRuntimes();
    },
    [refreshRuntimes],
  );

  useEffect(() => {
    void refresh();
    client
      .company()
      .then((r) => {
        setCompanyName(r.company.name);
        setDepartments(r.departments);
      })
      .catch(() => {
        /* header falls back to the default name; org chart stays empty */
      });
  }, [refresh, client]);

  useEffect(() => {
    const log = logRef.current;
    if (!log) return;
    // Element.scrollTo is absent in jsdom and in some older embedded webviews;
    // assigning scrollTop works everywhere and has the same effect here.
    if (typeof log.scrollTo === "function") log.scrollTo({ top: log.scrollHeight });
    else log.scrollTop = log.scrollHeight;
  }, [messages.length]);

  const send = useCallback(async () => {
    const body = draft.trim();
    if (!body || busy) return;
    setBusy(true);
    setError(null);
    try {
      await client.sendMessage(body);
      setDraft("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [draft, busy, client, refresh]);

  const runNext = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await client.executeNext();
      if (result.executed && result.runId) {
        const { events: runEvents } = await client.runEvents(result.runId);
        setEvents((prev) => [...prev, ...runEvents].slice(-200));
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [client, refresh]);

  // Shared mutation-dispatch shape: set busy, run the mutation, then run
  // whichever read-back keeps that dialog's own data current — `refresh()`
  // for the main poll, or a dialog-scoped refresher (refreshSecrets(),
  // refreshTaskAttachments(), ...) for state `refresh()` doesn't cover.
  const actWith = useCallback(async (fn: () => Promise<unknown>, after: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await after();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const act = useCallback((fn: () => Promise<unknown>) => actWith(fn, refresh), [actWith, refresh]);

  const markNotificationRead = useCallback(
    (id: string) => {
      void act(() => client.markNotificationRead(id));
    },
    [act, client],
  );

  // --- secrets (password-manager integration) -----------------------------

  const refreshSecrets = useCallback(async () => {
    const { secrets: s } = await client.secrets();
    setSecrets(s);
  }, [client]);

  const openSecrets = useCallback(() => {
    setShowSecrets(true);
    setSecretTestResults({});
    void refreshSecrets();
    client
      .secretProviders()
      .then((r) => setSecretProviders(r.providers))
      .catch(() => setSecretProviders([]));
  }, [client, refreshSecrets]);

  const createSecret = useCallback(() => {
    const name = newSecretName.trim();
    const itemRef = newSecretItemRef.trim();
    if (!name || !itemRef) return;
    void actWith(
      () =>
        client.createSecret({
          name,
          provider: newSecretProvider,
          itemRef,
          field: newSecretField.trim() || undefined,
        }),
      async () => {
        setNewSecretName("");
        setNewSecretItemRef("");
        setNewSecretField("");
        await refreshSecrets();
      },
    );
  }, [actWith, client, newSecretName, newSecretProvider, newSecretItemRef, newSecretField, refreshSecrets]);

  const deleteSecret = useCallback(
    (id: string) => {
      void actWith(
        () => client.deleteSecret(id),
        async () => {
          setSecretTestResults((prev) => {
            const next = { ...prev };
            delete next[id];
            return next;
          });
          await refreshSecrets();
        },
      );
    },
    [actWith, client, refreshSecrets],
  );

  const testSecret = useCallback(
    (id: string) => {
      void actWith(
        async () => {
          const result = await client.testSecret(id);
          setSecretTestResults((prev) => ({
            ...prev,
            [id]: { ok: result.ok, message: result.ok ? `OK (${result.length ?? 0} Zeichen)` : (result.message ?? "") },
          }));
        },
        async () => {},
      );
    },
    [actWith, client],
  );

  // --- network (Tailscale/Headscale status + remote workers over the tailnet) ---

  const refreshRemoteWorkers = useCallback(async () => {
    const { remoteWorkers: w } = await client.remoteWorkers();
    setRemoteWorkers(w);
  }, [client]);

  const openNetwork = useCallback(() => {
    setShowNetwork(true);
    setRemoteWorkerTestResults({});
    void refreshRemoteWorkers();
    client
      .tailscale()
      .then(setTailscaleInfo)
      .catch((err) =>
        setTailscaleInfo({ backendState: "Unknown", self: null, peers: [], ok: false, message: String(err) }),
      );
  }, [client, refreshRemoteWorkers]);

  const createRemoteWorker = useCallback(() => {
    const label = newWorkerLabel.trim();
    const host = newWorkerHost.trim();
    const sshUser = newWorkerSshUser.trim();
    const privateKeyPath = newWorkerPrivateKeyPath.trim();
    if (!label || !host || !sshUser || !privateKeyPath) return;
    void actWith(
      () =>
        client.createRemoteWorker({
          label,
          environment: newWorkerEnvironment.trim() || undefined,
          host,
          sshUser,
          privateKeyPath,
          knownHostsPolicy: newWorkerKnownHosts,
        }),
      async () => {
        setNewWorkerLabel("");
        setNewWorkerEnvironment("");
        setNewWorkerHost("");
        setNewWorkerSshUser("");
        setNewWorkerPrivateKeyPath("");
        await refreshRemoteWorkers();
      },
    );
  }, [
    actWith,
    client,
    newWorkerLabel,
    newWorkerEnvironment,
    newWorkerHost,
    newWorkerSshUser,
    newWorkerPrivateKeyPath,
    newWorkerKnownHosts,
    refreshRemoteWorkers,
  ]);

  const deleteRemoteWorker = useCallback(
    (id: string) => {
      void actWith(
        () => client.deleteRemoteWorker(id),
        async () => {
          setRemoteWorkerTestResults((prev) => {
            const next = { ...prev };
            delete next[id];
            return next;
          });
          await refreshRemoteWorkers();
        },
      );
    },
    [actWith, client, refreshRemoteWorkers],
  );

  const testRemoteWorker = useCallback(
    (id: string) => {
      void actWith(
        async () => {
          const result = await client.testRemoteWorker(id);
          setRemoteWorkerTestResults((prev) => ({ ...prev, [id]: result }));
        },
        async () => {},
      );
    },
    [actWith, client],
  );

  // --- meetings (moderator, bounded rounds, budget) -----------------------
  // One round is one participant's turn, so a meeting self-closes on its own
  // once max_rounds (or its budget cap) is reached — "Nächste Wortmeldung"
  // after that is a harmless no-op the backend reports with turn: null.

  const refreshMeetings = useCallback(async () => {
    const { meetings: m } = await client.meetings();
    setMeetings(m);
  }, [client]);

  const openMeetings = useCallback(() => {
    setShowMeetings(true);
    void refreshMeetings();
  }, [refreshMeetings]);

  const openMeetingDetail = useCallback(
    async (id: string) => {
      const detail = await client.meeting(id);
      setMeetingDetail(detail);
      setMeetingMinutesDraft(detail.meeting.minutes);
    },
    [client],
  );

  const refreshMeetingDetail = useCallback(async () => {
    if (!meetingDetail) return;
    const detail = await client.meeting(meetingDetail.meeting.id);
    setMeetingDetail(detail);
  }, [client, meetingDetail]);

  const closeMeetingDetail = useCallback(() => {
    setMeetingDetail(null);
    setNewActionItemDescription("");
    setNewActionItemAssigneeId("");
  }, []);

  const toggleMeetingParticipant = useCallback((agentId: string) => {
    setNewMeetingParticipantIds((prev) =>
      prev.includes(agentId) ? prev.filter((id) => id !== agentId) : [...prev, agentId],
    );
  }, []);

  const createMeeting = useCallback(() => {
    const topic = newMeetingTopic.trim();
    if (!topic || !newMeetingModeratorId || newMeetingParticipantIds.length === 0) return;
    void actWith(
      () =>
        client.createMeeting({
          topic,
          moderatorAgentId: newMeetingModeratorId,
          participantAgentIds: newMeetingParticipantIds,
          maxRounds: newMeetingMaxRounds,
        }),
      async () => {
        setNewMeetingTopic("");
        setNewMeetingParticipantIds([]);
        await refreshMeetings();
      },
    );
  }, [
    actWith,
    client,
    newMeetingTopic,
    newMeetingModeratorId,
    newMeetingParticipantIds,
    newMeetingMaxRounds,
    refreshMeetings,
  ]);

  const startMeeting = useCallback(
    (id: string) => {
      void actWith(
        () => client.startMeeting(id),
        async () => {
          await refreshMeetings();
          await refreshMeetingDetail();
        },
      );
    },
    [actWith, client, refreshMeetings, refreshMeetingDetail],
  );

  const nextMeetingTurn = useCallback(
    (id: string, agentId?: string) => {
      void actWith(
        () => client.nextMeetingTurn(id, agentId),
        async () => {
          await refreshMeetings();
          await refreshMeetingDetail();
        },
      );
    },
    [actWith, client, refreshMeetings, refreshMeetingDetail],
  );

  const endMeeting = useCallback(
    (id: string, minutes: string) => {
      void actWith(
        () => client.endMeeting(id, minutes),
        async () => {
          await refreshMeetings();
          await refreshMeetingDetail();
        },
      );
    },
    [actWith, client, refreshMeetings, refreshMeetingDetail],
  );

  const cancelMeeting = useCallback(
    (id: string) => {
      void actWith(
        () => client.cancelMeeting(id),
        async () => {
          await refreshMeetings();
          closeMeetingDetail();
        },
      );
    },
    [actWith, client, refreshMeetings, closeMeetingDetail],
  );

  const addMeetingActionItem = useCallback(
    (id: string) => {
      const description = newActionItemDescription.trim();
      if (!description) return;
      void actWith(
        () =>
          client.addMeetingActionItem(id, {
            description,
            assignedAgentId: newActionItemAssigneeId || undefined,
          }),
        async () => {
          setNewActionItemDescription("");
          setNewActionItemAssigneeId("");
          await refreshMeetingDetail();
        },
      );
    },
    [actWith, client, newActionItemDescription, newActionItemAssigneeId, refreshMeetingDetail],
  );

  const convertActionItem = useCallback(
    (actionItemId: string) => {
      void actWith(
        () => client.convertActionItemToTask(actionItemId),
        async () => {
          await refreshMeetingDetail();
          await refresh();
        },
      );
    },
    [actWith, client, refreshMeetingDetail, refresh],
  );

  // --- memory (the Obsidian vault, the first MemoryProvider) --------------

  const refreshMemory = useCallback(async () => {
    const [{ providers }, { memories: m }] = await Promise.all([client.memoryProviders(), client.memories()]);
    setMemoryProviders(providers);
    setMemories(m);
  }, [client]);

  const openMemory = useCallback(() => {
    setShowMemory(true);
    setMemorySearchHits(null);
    setMemoryQuery("");
    void refreshMemory();
  }, [refreshMemory]);

  const recordMemory = useCallback(() => {
    const title = newMemoryTitle.trim();
    const content = newMemoryContent.trim();
    const provider = memoryProviders[0]?.kind;
    if (!title || !content || !provider) return;
    void actWith(
      () => client.recordMemory({ provider, kind: newMemoryKind, title, content }),
      async () => {
        setNewMemoryTitle("");
        setNewMemoryContent("");
        await refreshMemory();
      },
    );
  }, [actWith, client, newMemoryKind, newMemoryTitle, newMemoryContent, memoryProviders, refreshMemory]);

  const openMemoryDetail = useCallback(
    (id: string) => {
      void actWith(
        async () => {
          const result = await client.memoryContent(id);
          setMemoryDetail(result);
        },
        async () => {},
      );
    },
    [actWith, client],
  );

  const deleteMemoryEntry = useCallback(
    (id: string) => {
      void actWith(
        () => client.deleteMemory(id),
        async () => {
          setMemoryDetail(null);
          await refreshMemory();
        },
      );
    },
    [actWith, client, refreshMemory],
  );

  const searchMemory = useCallback(() => {
    const query = memoryQuery.trim();
    const provider = memoryProviders[0]?.kind;
    if (!query || !provider) return;
    void actWith(
      async () => {
        const { hits } = await client.searchMemory(provider, query);
        setMemorySearchHits(hits);
      },
      async () => {},
    );
  }, [actWith, client, memoryQuery, memoryProviders]);

  // --- notification channels (Discord, Telegram, email fan-out) -----------

  const refreshChannels = useCallback(async () => {
    const { channels } = await client.notificationChannels();
    setNotificationChannels(channels);
  }, [client]);

  const openChannels = useCallback(() => {
    setShowChannels(true);
    setChannelTestResults({});
    void refreshChannels();
  }, [refreshChannels]);

  const testChannel = useCallback(
    (kind: string) => {
      void actWith(
        async () => {
          const result = await client.testNotificationChannel(kind);
          setChannelTestResults((prev) => ({ ...prev, [kind]: result }));
        },
        async () => {},
      );
    },
    [actWith, client],
  );

  const sendTestNotification = useCallback(
    (kind: string) => {
      void actWith(
        async () => {
          const result = await client.sendTestNotification(kind);
          setChannelTestResults((prev) => ({ ...prev, [kind]: result }));
        },
        async () => {},
      );
    },
    [actWith, client],
  );

  // --- attachments (task/project-scoped + the general document store) ----
  // refreshTaskAttachments / refreshProjectAttachments are declared earlier,
  // alongside openTaskDetail / openProjectDetail, which call them on open.

  const refreshGeneralAttachments = useCallback(async () => {
    const { attachments } = await client.attachmentsGeneral();
    setGeneralAttachments(attachments);
  }, [client]);

  const openDocuments = useCallback(() => {
    setShowDocuments(true);
    void refreshGeneralAttachments();
  }, [refreshGeneralAttachments]);

  const uploadAttachment = useCallback(
    (file: File, scope: { taskId?: string; projectId?: string }, after: () => Promise<void>) => {
      void actWith(async () => {
        const dataBase64 = await readFileAsBase64(file);
        await client.uploadAttachment({
          filename: file.name,
          contentType: file.type || undefined,
          dataBase64,
          ...scope,
        });
      }, after);
    },
    [actWith, client],
  );

  const deleteAttachment = useCallback(
    (id: string, after: () => Promise<void>) => {
      void actWith(() => client.deleteAttachment(id), after);
    },
    [actWith, client],
  );

  // Kanban drag & drop. There is no optimistic local mutation: a card only
  // ever moves to the column its `status` field in `tasks` actually says,
  // and that only changes once refresh() re-reads it after the server
  // accepted the move. A rejected move (409, illegal transition) surfaces
  // through the same `error` banner every other action uses, and the card
  // stays exactly where the backend still has it — "state changes must
  // never be frontend-only" (docs/ROADMAP.md Phase 2).
  const [draggedTaskId, setDraggedTaskId] = useState<string | null>(null);
  const [dragOverColumn, setDragOverColumn] = useState<TaskStatus | null>(null);

  const moveTask = useCallback(
    (taskId: string, status: TaskStatus) => {
      const current = tasks.find((t) => t.id === taskId);
      if (!current || current.status === status || busy) return;
      void act(() => client.setTaskStatus(taskId, status));
    },
    [tasks, busy, act, client],
  );

  const byStatus = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const t of tasks) {
      const list = map.get(t.status) ?? [];
      list.push(t);
      map.set(t.status, list);
    }
    return map;
  }, [tasks]);

  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const reviewable = tasks.filter((t) => t.status === "review");
  // Re-derived from the live agents list on every render, never a stale
  // snapshot: a runtime change made in the dialog is reflected the moment
  // refresh() lands, same as every other figure in this view.
  const currentAgent = selectedAgent ? (agentById.get(selectedAgent.id) ?? selectedAgent) : null;
  const currentRuntime = currentAgent ? runtimes.find((r) => r.type === currentAgent.runtimeProvider) : undefined;
  const taskById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const currentTask = selectedTask ? (taskById.get(selectedTask.id) ?? selectedTask) : null;
  const agentsByDepartment = useMemo(() => {
    const map = new Map<string, Agent[]>();
    for (const a of agents) {
      const list = map.get(a.departmentId ?? "") ?? [];
      list.push(a);
      map.set(a.departmentId ?? "", list);
    }
    return map;
  }, [agents]);

  return (
    <div className="ic-root" data-testid="command-center">
      {/* ------------------------------------------------------- top bar */}
      <header className="ic-topbar">
        <div className="ic-brand">
          <span className="ic-brand-mark">IRONCREW</span>
          <span className="ic-brand-sub">{companyName}</span>
        </div>

        <button type="button" className="ic-btn" data-testid="open-projects" onClick={() => setShowProjectList(true)}>
          Projekte ({projects.length})
        </button>

        <button
          type="button"
          className="ic-btn"
          data-variant={unreadCount > 0 ? "decision" : undefined}
          data-testid="open-inbox"
          onClick={() => setShowInbox(true)}
        >
          Postfach ({unreadCount})
        </button>

        <button type="button" className="ic-btn" data-testid="open-org-chart" onClick={() => setShowOrgChart(true)}>
          Organigramm
        </button>

        <button type="button" className="ic-btn" data-testid="open-documents" onClick={openDocuments}>
          Dokumente
        </button>

        <button type="button" className="ic-btn" data-testid="open-secrets" onClick={openSecrets}>
          Zugangsdaten
        </button>

        <button type="button" className="ic-btn" data-testid="open-network" onClick={openNetwork}>
          Netzwerk
        </button>

        <button type="button" className="ic-btn" data-testid="open-meetings" onClick={openMeetings}>
          Meetings
        </button>

        <button type="button" className="ic-btn" data-testid="open-memory" onClick={openMemory}>
          Wissen
        </button>

        <button type="button" className="ic-btn" data-testid="open-channels" onClick={openChannels}>
          Kanäle
        </button>

        <div className="ic-metrics" role="group" aria-label="Systemkennzahlen">
          <Metric label="Läuft" value={dashboard?.tasks.running ?? 0} tone="accent" />
          <Metric label="Review" value={dashboard?.tasks.review ?? 0} />
          <Metric label="Freigaben" value={dashboard?.approvalsPending ?? 0} tone="decision" />
          <Metric
            label="Blockiert"
            value={dashboard?.tasks.blocked ?? 0}
            tone={dashboard?.tasks.blocked ? "critical" : undefined}
          />
          <Metric label="Agents aktiv" value={dashboard?.agents.working ?? 0} />
          <Metric
            label="Audit"
            value={dashboard?.auditChainValid === false ? "BRUCH" : "OK"}
            tone={dashboard?.auditChainValid === false ? "critical" : undefined}
          />
        </div>
      </header>

      <div className="ic-main">
        {/* ------------------------------------------------- agent rail */}
        <nav className="ic-rail" aria-label="Mannschaft">
          <h2 className="ic-section-title">Mannschaft</h2>
          <div className="ic-agent-list">
            {agents.map((agent) => (
              <button
                key={agent.id}
                type="button"
                className="ic-agent"
                aria-pressed={selectedAgent?.id === agent.id}
                onClick={() => openAgentDetail(agent)}
              >
                <span
                  className="ic-status-dot"
                  data-status={agent.status}
                  data-testid={`agent-status-${agent.key}`}
                  aria-hidden="true"
                />
                <span>
                  <span className="ic-agent-name">{agent.displayName}</span>
                  <br />
                  <span className="ic-agent-role">{agent.professionalRole}</span>
                  {/* Status is announced in text, not only by colour. */}
                  <span className="ic-sr-only">Status: {AGENT_STATUS_LABEL[agent.status]}</span>
                </span>
                {agent.isExecutiveAssistant ? <span className="ic-agent-ea">EA</span> : <span />}
              </button>
            ))}
          </div>
        </nav>

        {/* ----------------------------------------------------- board */}
        <main className="ic-stage">
          <h2 className="ic-section-title">
            Aufgaben
            <button type="button" className="ic-btn" onClick={runNext} disabled={busy} data-testid="run-next">
              Nächste Aufgabe ausführen
            </button>
          </h2>

          {error && (
            <div className="ic-approval" role="alert" data-testid="error-banner">
              <div className="ic-approval-type">Fehler</div>
              <div className="ic-approval-summary">{error}</div>
            </div>
          )}

          <div className="ic-board" data-testid="kanban">
            {BOARD_COLUMNS.map(({ status, accent }) => {
              const items = byStatus.get(status) ?? [];
              return (
                <section
                  key={status}
                  className="ic-column"
                  data-accent={accent}
                  data-testid={`column-${status}`}
                  data-drag-over={dragOverColumn === status || undefined}
                  onDragOver={(e) => {
                    if (!draggedTaskId) return;
                    e.preventDefault();
                    setDragOverColumn(status);
                  }}
                  onDragLeave={() => setDragOverColumn((c) => (c === status ? null : c))}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragOverColumn(null);
                    const taskId = e.dataTransfer.getData("text/plain");
                    if (taskId) moveTask(taskId, status);
                  }}
                >
                  <h3 className="ic-column-head">
                    <span>{TASK_STATUS_LABEL[status]}</span>
                    <span className="ic-column-count">{items.length}</span>
                  </h3>
                  <div className="ic-column-body">
                    {items.length === 0 && <p className="ic-empty">—</p>}
                    {items.map((task) => (
                      <button
                        key={task.id}
                        type="button"
                        className="ic-card"
                        draggable
                        data-priority={task.priority}
                        data-risk={task.risk_level}
                        data-dragging={draggedTaskId === task.id || undefined}
                        onClick={() => openTaskDetail(task)}
                        onDragStart={(e) => {
                          e.dataTransfer.setData("text/plain", task.id);
                          e.dataTransfer.effectAllowed = "move";
                          setDraggedTaskId(task.id);
                        }}
                        onDragEnd={() => {
                          setDraggedTaskId(null);
                          setDragOverColumn(null);
                        }}
                      >
                        <span className="ic-card-title">{task.title}</span>
                        <span className="ic-card-meta">
                          <span>{agentById.get(task.assigned_agent_id ?? "")?.displayName ?? "—"}</span>
                          {task.sensitive === 1 && <span className="ic-redacted">sensibel</span>}
                        </span>
                      </button>
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        </main>

        {/* ------------------------------------------- CEO chat + inbox */}
        <aside className="ic-side" aria-label="CEO-Kanal">
          {approvals.length > 0 && (
            <>
              <h2 className="ic-section-title">Entscheidungen</h2>
              {approvals.map((approval) => (
                <div key={approval.id} className="ic-approval" data-testid={`approval-${approval.id}`}>
                  <div className="ic-approval-type">{approval.approval_type}</div>
                  <div className="ic-approval-summary">{approval.summary}</div>
                  <div className="ic-approval-actions">
                    <button
                      type="button"
                      className="ic-btn"
                      data-variant="decision"
                      disabled={busy}
                      onClick={() => act(() => client.decide(approval.id, "approved"))}
                    >
                      Freigeben
                    </button>
                    <button
                      type="button"
                      className="ic-btn"
                      data-variant="danger"
                      disabled={busy}
                      onClick={() => act(() => client.decide(approval.id, "rejected"))}
                    >
                      Ablehnen
                    </button>
                  </div>
                </div>
              ))}
            </>
          )}

          {reviewable.length > 0 && (
            <>
              <h2 className="ic-section-title">Zur Abnahme</h2>
              {reviewable.map((task) => (
                <div key={task.id} className="ic-approval" data-testid={`review-${task.id}`}>
                  <div className="ic-approval-type">Review</div>
                  <div className="ic-approval-summary">{task.title}</div>
                  <div className="ic-approval-actions">
                    <button
                      type="button"
                      className="ic-btn"
                      data-variant="decision"
                      disabled={busy}
                      onClick={() => act(() => client.accept(task.id))}
                    >
                      Abnehmen
                    </button>
                    <button
                      type="button"
                      className="ic-btn"
                      disabled={busy}
                      onClick={() => act(() => client.revise(task.id, "Bitte überarbeiten."))}
                    >
                      Revision
                    </button>
                  </div>
                </div>
              ))}
            </>
          )}

          <h2 className="ic-section-title">CEO-Kanal</h2>
          <div className="ic-chat-log" ref={logRef} data-testid="chat-log">
            {messages.length === 0 && (
              <p className="ic-note">
                Ihr zentraler Ansprechpartner ist die Executive Assistant. Schreiben Sie, was zu tun ist — Triage,
                Planung und Delegation übernimmt sie.
              </p>
            )}
            {messages.map((msg) => {
              const triage = msg.triage_json
                ? (JSON.parse(msg.triage_json) as { category: string; confidence: number })
                : null;
              return (
                <div key={msg.id} className="ic-msg" data-role={msg.role}>
                  <div className="ic-msg-author">
                    {msg.role === "ceo" ? "CEO" : (agentById.get(msg.author_agent_id ?? "")?.displayName ?? "System")}
                    {" · "}
                    {formatTime(msg.created_at)}
                  </div>
                  <div className="ic-msg-body">{msg.body}</div>
                  {triage && msg.role === "ceo" && (
                    <div className="ic-triage">
                      Triage: {triage.category} · Konfidenz {(triage.confidence * 100).toFixed(0)}%
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="ic-composer">
            <label className="ic-sr-only" htmlFor="ic-composer-input">
              Nachricht an die Executive Assistant
            </label>
            <textarea
              id="ic-composer-input"
              data-testid="chat-input"
              value={draft}
              placeholder="Auftrag an die Executive Assistant …"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send();
              }}
            />
            <button
              type="button"
              className="ic-btn"
              data-variant="primary"
              data-testid="chat-send"
              onClick={send}
              disabled={busy || draft.trim().length === 0}
            >
              Senden
            </button>
          </div>
        </aside>
      </div>

      {/* --------------------------------------------------- event drawer */}
      <section className="ic-drawer" aria-label="Ereignisverlauf">
        <div className="ic-drawer-head">
          <h2 className="ic-section-title" style={{ padding: 0 }}>
            Run-Ereignisse
          </h2>
        </div>
        <div className="ic-event-log" data-testid="event-log">
          {events.length === 0 && <p className="ic-empty">Noch keine Ereignisse.</p>}
          {events.slice(-60).map((ev) => (
            <div key={ev.eventId} className="ic-event" data-kind={eventKind(ev.type)}>
              <span className="ic-event-time">{formatTime(ev.timestamp)}</span>
              <span className="ic-event-type">{ev.type}</span>
              <span className="ic-event-body">
                {ev.redaction.redacted && <span className="ic-redacted">redigiert</span>}{" "}
                {JSON.stringify(ev.payload).slice(0, 160)}
              </span>
            </div>
          ))}
        </div>
      </section>

      {currentTask && (
        <DetailDialog title={currentTask.title} onClose={() => setSelectedTask(null)}>
          <dl>
            <dt>Status</dt>
            <dd>{TASK_STATUS_LABEL[currentTask.status]}</dd>
            <dt>Priorität</dt>
            <dd>{currentTask.priority}</dd>
            <dt>Risiko</dt>
            <dd>{currentTask.risk_level}</dd>
            <dt>Verantwortlich</dt>
            <dd>{agentById.get(currentTask.assigned_agent_id ?? "")?.displayName ?? "nicht zugewiesen"}</dd>
            <dt>Correlation</dt>
            <dd>
              <code>{currentTask.correlation_id}</code>
            </dd>
          </dl>
          {currentTask.result_summary && <p className="ic-note">{currentTask.result_summary}</p>}

          <h3 className="ic-section-title" style={{ padding: "8px 0 4px" }}>
            Blockiert durch
          </h3>
          {taskBlockers.length === 0 && <p className="ic-empty">—</p>}
          <ul className="ic-milestone-list">
            {taskBlockers.map((b) => (
              <li key={b.id}>
                <span className="ic-milestone-title">{b.title}</span>
                <span className="ic-tag" data-tone={b.status === "done" ? "policy" : "gate"}>
                  {TASK_STATUS_LABEL[b.status]}
                </span>
                <button
                  type="button"
                  className="ic-btn"
                  disabled={busy}
                  onClick={() =>
                    act(async () => {
                      await client.removeDependency(currentTask.id, b.id);
                      await refreshTaskDependencies(currentTask.id);
                    })
                  }
                >
                  Entfernen
                </button>
              </li>
            ))}
          </ul>
          <div className="ic-composer" style={{ padding: 0 }}>
            <label className="ic-sr-only" htmlFor="ic-add-blocker-select">
              Blocker für {currentTask.title} hinzufügen
            </label>
            <select
              id="ic-add-blocker-select"
              className="ic-select"
              value={addBlockerId}
              onChange={(e) => setAddBlockerId(e.target.value)}
            >
              <option value="">Blocker wählen…</option>
              {tasks
                .filter((t) => t.id !== currentTask.id && !taskBlockers.some((b) => b.id === t.id))
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.title}
                  </option>
                ))}
            </select>
            <button
              type="button"
              className="ic-btn"
              disabled={!addBlockerId || busy}
              onClick={() =>
                act(async () => {
                  await client.addDependency(currentTask.id, addBlockerId);
                  setAddBlockerId("");
                  await refreshTaskDependencies(currentTask.id);
                })
              }
            >
              Hinzufügen
            </button>
          </div>

          {taskBlocking.length > 0 && (
            <>
              <h3 className="ic-section-title" style={{ padding: "8px 0 4px" }}>
                Blockiert
              </h3>
              <ul className="ic-milestone-list">
                {taskBlocking.map((b) => (
                  <li key={b.id}>
                    <span className="ic-milestone-title">{b.title}</span>
                    <span className="ic-tag">{TASK_STATUS_LABEL[b.status]}</span>
                  </li>
                ))}
              </ul>
            </>
          )}

          <AttachmentSection
            title="Anhänge"
            attachments={taskAttachments}
            busy={busy}
            onUpload={(file) =>
              uploadAttachment(file, { taskId: currentTask.id }, () => refreshTaskAttachments(currentTask.id))
            }
            onDelete={(id) => deleteAttachment(id, () => refreshTaskAttachments(currentTask.id))}
            downloadUrl={(id) => client.attachmentDownloadUrl(id)}
          />
        </DetailDialog>
      )}

      {currentAgent && (
        <DetailDialog title={currentAgent.displayName} onClose={() => setSelectedAgent(null)}>
          <dl>
            <dt>Rolle</dt>
            <dd>{currentAgent.professionalRole}</dd>
            <dt>Status</dt>
            <dd>{AGENT_STATUS_LABEL[currentAgent.status]}</dd>
            <dt>Runtime</dt>
            <dd>
              <label className="ic-sr-only" htmlFor="ic-agent-runtime-select">
                Runtime für {currentAgent.displayName}
              </label>
              <select
                id="ic-agent-runtime-select"
                className="ic-select"
                data-testid="agent-runtime-select"
                value={currentAgent.runtimeProvider}
                disabled={busy}
                onChange={(e) => act(() => client.setAgentRuntime(currentAgent.id, e.target.value))}
              >
                {/* An agent can be pointed at a provider this install no longer
                    has registered (e.g. after a config change) — surface that
                    honestly as its own option rather than silently showing a
                    different one selected. */}
                {!runtimes.some((r) => r.type === currentAgent.runtimeProvider) && (
                  <option value={currentAgent.runtimeProvider}>
                    {currentAgent.runtimeProvider} (nicht registriert)
                  </option>
                )}
                {runtimes.map((r) => (
                  <option key={r.type} value={r.type}>
                    {r.type} {r.health.healthy ? "● bereit" : "○ nicht verfügbar"}
                  </option>
                ))}
              </select>
              {" · "}
              {currentAgent.runtimeProfile}
              {currentRuntime && (
                <>
                  <br />
                  <span className="ic-note" data-testid="agent-runtime-detail">
                    {currentRuntime.auth.authenticated ? "Angemeldet" : "Nicht angemeldet"} ·{" "}
                    {currentRuntime.health.detail}
                  </span>
                </>
              )}
            </dd>
            <dt>Max. Risiko</dt>
            <dd>{currentAgent.policy.max_risk_level}</dd>
            <dt>Werkzeuge</dt>
            <dd>
              {currentAgent.policy.allowed_tools.map((t) => (
                <span key={t} className="ic-tag" data-tone="policy">
                  {t}
                </span>
              ))}
            </dd>
            <dt>Freigabepflichtig</dt>
            <dd>
              {currentAgent.policy.requires_approval_for.length === 0
                ? "—"
                : currentAgent.policy.requires_approval_for.map((t) => (
                    <span key={t} className="ic-tag" data-tone="gate">
                      {t}
                    </span>
                  ))}
            </dd>
            <dt>Auftreten</dt>
            <dd>{currentAgent.persona.traits.join(", ") || "—"}</dd>
          </dl>
          <p className="ic-note">
            Das Auftreten ist rein stilistisch. Es kann Berechtigungen, Werkzeuge oder Freigabepflichten nicht verändern
            — Policy hat immer Vorrang.
          </p>
        </DetailDialog>
      )}

      {showProjectList && !projectDetail && (
        <DetailDialog title="Projekte" onClose={() => setShowProjectList(false)}>
          {projects.length === 0 && <p className="ic-empty">Noch keine Projekte.</p>}
          <div className="ic-project-list">
            {projects.map((p) => (
              <button
                key={p.id}
                type="button"
                className="ic-project"
                data-testid={`project-${p.key}`}
                onClick={() => void openProjectDetail(p.id)}
              >
                <span className="ic-project-title">{p.title}</span>
                <span className="ic-project-meta">
                  {p.key} · {PROJECT_STATUS_LABEL[p.status]}
                </span>
              </button>
            ))}
          </div>
        </DetailDialog>
      )}

      {projectDetail && (
        <DetailDialog title={projectDetail.project.title} onClose={closeProjectDetail}>
          <dl>
            <dt>Schlüssel</dt>
            <dd>
              <code>{projectDetail.project.key}</code>
            </dd>
            <dt>Status</dt>
            <dd>{PROJECT_STATUS_LABEL[projectDetail.project.status]}</dd>
            {projectGoalAncestry && projectGoalAncestry.length > 0 && (
              <>
                <dt>Ziel</dt>
                <dd data-testid="project-goal-ancestry">{projectGoalAncestry.map((g) => g.title).join(" -> ")}</dd>
              </>
            )}
            {projectDetail.project.summary && (
              <>
                <dt>Zusammenfassung</dt>
                <dd>{projectDetail.project.summary}</dd>
              </>
            )}
          </dl>

          <h3 className="ic-section-title" style={{ padding: "8px 0 4px" }}>
            Meilensteine
          </h3>
          {projectDetail.milestones.length === 0 && <p className="ic-empty">—</p>}
          <ul className="ic-milestone-list">
            {projectDetail.milestones.map((m) => (
              <li key={m.id} className="ic-milestone" data-status={m.status}>
                <span className="ic-milestone-title">{m.title}</span>
                <span className="ic-tag" data-tone={m.status === "missed" ? "gate" : "policy"}>
                  {MILESTONE_STATUS_LABEL[m.status]}
                </span>
                {m.status === "pending" && (
                  <button
                    type="button"
                    className="ic-btn"
                    disabled={busy}
                    onClick={() =>
                      act(async () => {
                        await client.setMilestoneStatus(m.id, "done");
                        await refreshProjectDetail();
                      })
                    }
                  >
                    Erledigt
                  </button>
                )}
              </li>
            ))}
          </ul>

          <h3 className="ic-section-title" style={{ padding: "8px 0 4px" }}>
            Aufgaben
          </h3>
          {projectDetail.tasks.length === 0 && <p className="ic-empty">—</p>}
          <ul className="ic-milestone-list">
            {projectDetail.tasks.map((t) => (
              <li key={t.id}>
                <span>{t.title}</span> <span className="ic-tag">{TASK_STATUS_LABEL[t.status]}</span>
              </li>
            ))}
          </ul>

          <AttachmentSection
            title="Anhänge"
            attachments={projectAttachments}
            busy={busy}
            onUpload={(file) =>
              uploadAttachment(file, { projectId: projectDetail.project.id }, () =>
                refreshProjectAttachments(projectDetail.project.id),
              )
            }
            onDelete={(id) => deleteAttachment(id, () => refreshProjectAttachments(projectDetail.project.id))}
            downloadUrl={(id) => client.attachmentDownloadUrl(id)}
          />
        </DetailDialog>
      )}

      {showInbox && (
        <DetailDialog title="Postfach" onClose={() => setShowInbox(false)}>
          <h3 className="ic-section-title" style={{ padding: 0 }}>
            Benachrichtigungen
          </h3>
          {notifications.length === 0 && <p className="ic-empty">—</p>}
          <ul className="ic-milestone-list">
            {notifications.map((n) => (
              <li key={n.id} data-testid={`notification-${n.id}`}>
                <span className="ic-milestone-title" style={n.read_at ? { opacity: 0.5 } : undefined}>
                  {n.title}
                </span>
                <span
                  className="ic-tag"
                  data-tone={n.severity === "critical" ? "gate" : n.severity === "warning" ? "gate" : "policy"}
                >
                  {NOTIFICATION_SEVERITY_LABEL[n.severity]}
                </span>
                {!n.read_at && (
                  <button type="button" className="ic-btn" disabled={busy} onClick={() => markNotificationRead(n.id)}>
                    Gelesen
                  </button>
                )}
              </li>
            ))}
          </ul>

          <h3 className="ic-section-title" style={{ padding: "10px 0 4px" }}>
            Entscheidungsprotokoll
          </h3>
          {decisions.length === 0 && <p className="ic-empty">—</p>}
          <ul className="ic-milestone-list">
            {decisions.map((d) => (
              <li key={d.id}>
                <span className="ic-milestone-title">{d.title}</span>
                <span className="ic-tag" data-tone={d.decision === "approved" ? "policy" : "gate"}>
                  {d.decision}
                </span>
              </li>
            ))}
          </ul>
        </DetailDialog>
      )}

      {showOrgChart && (
        <DetailDialog title="Organigramm" onClose={() => setShowOrgChart(false)}>
          {departments.length === 0 && <p className="ic-empty">—</p>}
          {departments.map((dept) => {
            const deptAgents = agentsByDepartment.get(dept.id) ?? [];
            return (
              <div key={dept.id} data-testid={`org-department-${dept.key}`}>
                <h3 className="ic-section-title" style={{ padding: "6px 0 4px" }}>
                  {dept.name} ({deptAgents.length})
                </h3>
                {deptAgents.length === 0 && <p className="ic-empty">—</p>}
                <div className="ic-project-list">
                  {deptAgents.map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      className="ic-project"
                      data-testid={`org-agent-${a.key}`}
                      onClick={() => openAgentDetail(a)}
                    >
                      <span className="ic-project-title">
                        {a.displayName}
                        {a.isExecutiveAssistant ? " · EA" : ""}
                      </span>
                      <span className="ic-project-meta">
                        {a.professionalRole} · {AGENT_STATUS_LABEL[a.status]}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
          {(agentsByDepartment.get("") ?? []).length > 0 && (
            <>
              <h3 className="ic-section-title" style={{ padding: "6px 0 4px" }}>
                Ohne Abteilung
              </h3>
              <div className="ic-project-list">
                {(agentsByDepartment.get("") ?? []).map((a) => (
                  <button key={a.id} type="button" className="ic-project" onClick={() => openAgentDetail(a)}>
                    <span className="ic-project-title">{a.displayName}</span>
                    <span className="ic-project-meta">{a.professionalRole}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </DetailDialog>
      )}

      {showDocuments && (
        <DetailDialog title="Dokumente" onClose={() => setShowDocuments(false)}>
          <p className="ic-note">
            Allgemeiner, unternehmensweiter Dokumenten-Speicher — nicht an eine Aufgabe oder ein Projekt gebunden.
          </p>
          <AttachmentSection
            title="Dateien"
            attachments={generalAttachments}
            busy={busy}
            onUpload={(file) => uploadAttachment(file, {}, refreshGeneralAttachments)}
            onDelete={(id) => deleteAttachment(id, refreshGeneralAttachments)}
            downloadUrl={(id) => client.attachmentDownloadUrl(id)}
          />
        </DetailDialog>
      )}

      {showSecrets && (
        <DetailDialog title="Zugangsdaten" onClose={() => setShowSecrets(false)}>
          <p className="ic-note">
            Es wird nie ein Passwort gespeichert — nur ein Verweis (Anbieter + Eintrag), wo das Secret im
            Passwort-Manager liegt. Aufgelöst wird der Wert erst im Moment der Nutzung, im Arbeitsspeicher.
          </p>

          <h3 className="ic-section-title" style={{ padding: "8px 0 4px" }}>
            Anbieter
          </h3>
          <ul className="ic-milestone-list">
            {secretProviders.map((p) => (
              <li key={p.kind} data-testid={`secret-provider-${p.kind}`}>
                <span className="ic-milestone-title">{SECRET_PROVIDER_LABEL[p.kind]}</span>
                <span className="ic-tag" data-tone={p.registered && p.ok ? "policy" : "gate"}>
                  {p.registered ? (p.ok ? "verbunden" : "nicht erreichbar") : "nicht registriert"}
                </span>
                <span className="ic-note">{p.message}</span>
              </li>
            ))}
          </ul>

          <h3 className="ic-section-title" style={{ padding: "8px 0 4px" }}>
            Gespeicherte Verweise
          </h3>
          {secrets.length === 0 && <p className="ic-empty">—</p>}
          <ul className="ic-milestone-list">
            {secrets.map((s) => (
              <li key={s.id} data-testid={`secret-${s.id}`}>
                <span className="ic-milestone-title">{s.name}</span>
                <span className="ic-tag" data-tone="policy">
                  {SECRET_PROVIDER_LABEL[s.provider]}
                </span>
                <span className="ic-note">
                  {s.item_ref}
                  {s.field ? ` · ${s.field}` : ""}
                </span>
                <button type="button" className="ic-btn" disabled={busy} onClick={() => testSecret(s.id)}>
                  Testen
                </button>
                {secretTestResults[s.id] && (
                  <span
                    className="ic-tag"
                    data-testid={`secret-test-${s.id}`}
                    data-tone={secretTestResults[s.id].ok ? "policy" : "gate"}
                  >
                    {secretTestResults[s.id].message}
                  </span>
                )}
                <button
                  type="button"
                  className="ic-btn"
                  data-variant="danger"
                  disabled={busy}
                  onClick={() => deleteSecret(s.id)}
                >
                  Löschen
                </button>
              </li>
            ))}
          </ul>

          <h3 className="ic-section-title" style={{ padding: "8px 0 4px" }}>
            Neuer Verweis
          </h3>
          <div className="ic-composer" style={{ padding: 0, flexWrap: "wrap" }}>
            <label className="ic-sr-only" htmlFor="ic-new-secret-name">
              Name
            </label>
            <input
              id="ic-new-secret-name"
              data-testid="new-secret-name"
              placeholder="Name (z. B. github-pat)"
              value={newSecretName}
              onChange={(e) => setNewSecretName(e.target.value)}
            />
            <label className="ic-sr-only" htmlFor="ic-new-secret-provider">
              Anbieter
            </label>
            <select
              id="ic-new-secret-provider"
              className="ic-select"
              data-testid="new-secret-provider"
              value={newSecretProvider}
              onChange={(e) => setNewSecretProvider(e.target.value as SecretProviderKind)}
            >
              <option value="vaultwarden">Vaultwarden</option>
              <option value="protonpass">Proton Pass</option>
            </select>
            <label className="ic-sr-only" htmlFor="ic-new-secret-itemref">
              Eintrag
            </label>
            <input
              id="ic-new-secret-itemref"
              data-testid="new-secret-itemref"
              placeholder={newSecretProvider === "vaultwarden" ? "Item-Name in Vaultwarden" : "shareId:itemId"}
              value={newSecretItemRef}
              onChange={(e) => setNewSecretItemRef(e.target.value)}
            />
            <label className="ic-sr-only" htmlFor="ic-new-secret-field">
              Feld (optional)
            </label>
            <input
              id="ic-new-secret-field"
              data-testid="new-secret-field"
              placeholder="Feld (optional, z. B. password)"
              value={newSecretField}
              onChange={(e) => setNewSecretField(e.target.value)}
            />
            <button
              type="button"
              className="ic-btn"
              data-variant="primary"
              data-testid="new-secret-submit"
              disabled={busy || !newSecretName.trim() || !newSecretItemRef.trim()}
              onClick={createSecret}
            >
              Hinzufügen
            </button>
          </div>
        </DetailDialog>
      )}

      {showNetwork && (
        <DetailDialog title="Netzwerk" onClose={() => setShowNetwork(false)}>
          <p className="ic-note">
            Tailscale (oder ein selbstgehosteter, protokollkompatibler Kontrollserver wie Headscale) verbindet diesen
            Server mit entfernten Workern — Tier0-Umgebungen oder Kundennetzen — über SSH im Tailnet.
          </p>

          <h3 className="ic-section-title" style={{ padding: "8px 0 4px" }}>
            Dieser Knoten
          </h3>
          {tailscaleInfo && (
            <ul className="ic-milestone-list">
              <li data-testid="tailscale-self-status">
                <span className="ic-milestone-title">{tailscaleInfo.self?.hostName ?? "—"}</span>
                <span className="ic-tag" data-tone={tailscaleInfo.ok ? "policy" : "gate"}>
                  {tailscaleInfo.backendState}
                </span>
                <span className="ic-note">{tailscaleInfo.message}</span>
              </li>
            </ul>
          )}

          {tailscaleInfo && tailscaleInfo.peers.length > 0 && (
            <>
              <h3 className="ic-section-title" style={{ padding: "8px 0 4px" }}>
                Tailnet-Peers
              </h3>
              <ul className="ic-milestone-list">
                {tailscaleInfo.peers.map((p) => (
                  <li key={p.id}>
                    <span className="ic-milestone-title">{p.hostName}</span>
                    <span className="ic-tag" data-tone={p.online ? "policy" : "gate"}>
                      {p.online ? "online" : "offline"}
                    </span>
                    <span className="ic-note">{p.tailscaleIPs[0] ?? p.dnsName}</span>
                  </li>
                ))}
              </ul>
            </>
          )}

          <h3 className="ic-section-title" style={{ padding: "8px 0 4px" }}>
            Remote Worker
          </h3>
          {remoteWorkers.length === 0 && <p className="ic-empty">—</p>}
          <ul className="ic-milestone-list">
            {remoteWorkers.map((w) => (
              <li key={w.id} data-testid={`remote-worker-${w.id}`}>
                <span className="ic-milestone-title">{w.label}</span>
                <span className="ic-tag">{w.environment || "—"}</span>
                <span className="ic-note">
                  {w.ssh_user}@{w.host}:{w.port}
                </span>
                <button type="button" className="ic-btn" disabled={busy} onClick={() => testRemoteWorker(w.id)}>
                  Testen
                </button>
                {remoteWorkerTestResults[w.id] && (
                  <span
                    className="ic-tag"
                    data-testid={`remote-worker-test-${w.id}`}
                    data-tone={remoteWorkerTestResults[w.id].ok ? "policy" : "gate"}
                  >
                    {remoteWorkerTestResults[w.id].message}
                  </span>
                )}
                <button
                  type="button"
                  className="ic-btn"
                  data-variant="danger"
                  disabled={busy}
                  onClick={() => deleteRemoteWorker(w.id)}
                >
                  Entfernen
                </button>
              </li>
            ))}
          </ul>

          <h3 className="ic-section-title" style={{ padding: "8px 0 4px" }}>
            Neuer Remote Worker
          </h3>
          <div className="ic-composer" style={{ padding: 0, flexWrap: "wrap" }}>
            <label className="ic-sr-only" htmlFor="ic-new-worker-label">
              Label
            </label>
            <input
              id="ic-new-worker-label"
              data-testid="new-worker-label"
              placeholder="Label (z. B. tier0-acme)"
              value={newWorkerLabel}
              onChange={(e) => setNewWorkerLabel(e.target.value)}
            />
            <label className="ic-sr-only" htmlFor="ic-new-worker-environment">
              Umgebung
            </label>
            <input
              id="ic-new-worker-environment"
              data-testid="new-worker-environment"
              placeholder="Umgebung (z. B. customer:acme)"
              value={newWorkerEnvironment}
              onChange={(e) => setNewWorkerEnvironment(e.target.value)}
            />
            <label className="ic-sr-only" htmlFor="ic-new-worker-host">
              Tailnet-Host
            </label>
            <input
              id="ic-new-worker-host"
              data-testid="new-worker-host"
              placeholder="Tailnet-IP oder Hostname"
              value={newWorkerHost}
              onChange={(e) => setNewWorkerHost(e.target.value)}
            />
            <label className="ic-sr-only" htmlFor="ic-new-worker-ssh-user">
              SSH-Benutzer
            </label>
            <input
              id="ic-new-worker-ssh-user"
              data-testid="new-worker-ssh-user"
              placeholder="SSH-Benutzer"
              value={newWorkerSshUser}
              onChange={(e) => setNewWorkerSshUser(e.target.value)}
            />
            <label className="ic-sr-only" htmlFor="ic-new-worker-key-path">
              Pfad zum privaten Schlüssel
            </label>
            <input
              id="ic-new-worker-key-path"
              data-testid="new-worker-key-path"
              placeholder="Pfad zum privaten SSH-Schlüssel"
              value={newWorkerPrivateKeyPath}
              onChange={(e) => setNewWorkerPrivateKeyPath(e.target.value)}
            />
            <label className="ic-sr-only" htmlFor="ic-new-worker-known-hosts">
              Known-Hosts-Richtlinie
            </label>
            <select
              id="ic-new-worker-known-hosts"
              className="ic-select"
              data-testid="new-worker-known-hosts"
              value={newWorkerKnownHosts}
              onChange={(e) => setNewWorkerKnownHosts(e.target.value as KnownHostsPolicy)}
            >
              <option value="strict">strict</option>
              <option value="accept">accept</option>
            </select>
            <button
              type="button"
              className="ic-btn"
              data-variant="primary"
              data-testid="new-worker-submit"
              disabled={
                busy ||
                !newWorkerLabel.trim() ||
                !newWorkerHost.trim() ||
                !newWorkerSshUser.trim() ||
                !newWorkerPrivateKeyPath.trim()
              }
              onClick={createRemoteWorker}
            >
              Hinzufügen
            </button>
          </div>
        </DetailDialog>
      )}

      {showMeetings && (
        <DetailDialog title="Meetings" onClose={() => setShowMeetings(false)}>
          <p className="ic-note">
            Eine Runde ist eine Wortmeldung — die Gesamtzahl der Runden ist durch die max. Rundenzahl begrenzt, nicht
            durch Teilnehmerzahl × Runden. Ein Meeting schließt sich selbst, sobald die Rundenzahl oder das Budget
            erreicht ist.
          </p>

          {meetings.length === 0 && <p className="ic-empty">Noch keine Meetings.</p>}
          <ul className="ic-milestone-list">
            {meetings.map((m) => (
              <li key={m.id} data-testid={`meeting-${m.id}`}>
                <span className="ic-milestone-title">{m.topic}</span>
                <span className="ic-tag" data-tone={m.status === "cancelled" ? "gate" : "policy"}>
                  {MEETING_STATUS_LABEL[m.status]}
                </span>
                <span className="ic-note">
                  Runde {m.current_round}/{m.max_rounds}
                </span>
                <button type="button" className="ic-btn" onClick={() => void openMeetingDetail(m.id)}>
                  Öffnen
                </button>
              </li>
            ))}
          </ul>

          <h3 className="ic-section-title" style={{ padding: "8px 0 4px" }}>
            Neues Meeting
          </h3>
          <div className="ic-composer" style={{ padding: 0, flexWrap: "wrap" }}>
            <label className="ic-sr-only" htmlFor="ic-new-meeting-topic">
              Thema
            </label>
            <input
              id="ic-new-meeting-topic"
              data-testid="new-meeting-topic"
              placeholder="Thema"
              value={newMeetingTopic}
              onChange={(e) => setNewMeetingTopic(e.target.value)}
            />
            <label className="ic-sr-only" htmlFor="ic-new-meeting-moderator">
              Moderator
            </label>
            <select
              id="ic-new-meeting-moderator"
              className="ic-select"
              data-testid="new-meeting-moderator"
              value={newMeetingModeratorId}
              onChange={(e) => setNewMeetingModeratorId(e.target.value)}
            >
              <option value="">Moderator wählen…</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.displayName}
                </option>
              ))}
            </select>
            <label className="ic-sr-only" htmlFor="ic-new-meeting-max-rounds">
              Max. Rundenzahl
            </label>
            <input
              id="ic-new-meeting-max-rounds"
              type="number"
              min={1}
              max={50}
              data-testid="new-meeting-max-rounds"
              value={newMeetingMaxRounds}
              onChange={(e) => setNewMeetingMaxRounds(Number(e.target.value) || 1)}
            />
          </div>
          <fieldset className="ic-milestone-list" style={{ border: "none", margin: 0, padding: "4px 0" }}>
            <legend className="ic-note">Teilnehmer</legend>
            {agents.map((a) => (
              <label key={a.id} className="ic-note" style={{ display: "block" }}>
                <input
                  type="checkbox"
                  data-testid={`new-meeting-participant-${a.id}`}
                  checked={newMeetingParticipantIds.includes(a.id)}
                  onChange={() => toggleMeetingParticipant(a.id)}
                />{" "}
                {a.displayName}
              </label>
            ))}
          </fieldset>
          <button
            type="button"
            className="ic-btn"
            data-variant="primary"
            data-testid="new-meeting-submit"
            disabled={
              busy || !newMeetingTopic.trim() || !newMeetingModeratorId || newMeetingParticipantIds.length === 0
            }
            onClick={createMeeting}
          >
            Anlegen
          </button>
        </DetailDialog>
      )}

      {meetingDetail && (
        <DetailDialog title={meetingDetail.meeting.topic} onClose={closeMeetingDetail}>
          <dl>
            <dt>Status</dt>
            <dd data-testid="meeting-detail-status">{MEETING_STATUS_LABEL[meetingDetail.meeting.status]}</dd>
            <dt>Runde</dt>
            <dd>
              {meetingDetail.meeting.current_round}/{meetingDetail.meeting.max_rounds}
            </dd>
            {meetingDetail.meeting.budget_micros > 0 && (
              <>
                <dt>Budget</dt>
                <dd>
                  {(meetingDetail.meeting.spent_micros / 1_000_000).toFixed(2)} /{" "}
                  {(meetingDetail.meeting.budget_micros / 1_000_000).toFixed(2)} USD
                </dd>
              </>
            )}
          </dl>

          <h3 className="ic-section-title" style={{ padding: "8px 0 4px" }}>
            Teilnehmer
          </h3>
          <ul className="ic-milestone-list">
            {meetingDetail.participants.map((p) => (
              <li key={p.agent_id}>
                <span className="ic-milestone-title">{p.display_name}</span>
                {p.agent_id === meetingDetail.meeting.moderator_agent_id && (
                  <span className="ic-tag" data-tone="policy">
                    Moderator
                  </span>
                )}
                <span className="ic-note">{p.professional_role}</span>
              </li>
            ))}
          </ul>

          <h3 className="ic-section-title" style={{ padding: "8px 0 4px" }}>
            Verlauf
          </h3>
          {meetingDetail.turns.length === 0 && <p className="ic-empty">Noch keine Wortmeldungen.</p>}
          <ul className="ic-milestone-list" data-testid="meeting-turns">
            {meetingDetail.turns.map((t) => (
              <li key={t.id}>
                <span className="ic-milestone-title">
                  {meetingDetail.participants.find((p) => p.agent_id === t.agent_id)?.display_name ?? t.agent_id}
                </span>
                <span className="ic-tag">Runde {t.round}</span>
                <span className="ic-note">{t.contribution}</span>
              </li>
            ))}
          </ul>

          {meetingDetail.meeting.status === "scheduled" && (
            <button
              type="button"
              className="ic-btn"
              data-variant="primary"
              data-testid="meeting-start"
              disabled={busy}
              onClick={() => startMeeting(meetingDetail.meeting.id)}
            >
              Starten
            </button>
          )}

          {meetingDetail.meeting.status === "in_progress" && (
            <button
              type="button"
              className="ic-btn"
              data-variant="primary"
              data-testid="meeting-next-turn"
              disabled={busy}
              onClick={() => nextMeetingTurn(meetingDetail.meeting.id)}
            >
              Nächste Wortmeldung
            </button>
          )}

          {(meetingDetail.meeting.status === "scheduled" || meetingDetail.meeting.status === "in_progress") && (
            <button
              type="button"
              className="ic-btn"
              data-variant="danger"
              data-testid="meeting-cancel"
              disabled={busy}
              onClick={() => cancelMeeting(meetingDetail.meeting.id)}
            >
              Abbrechen
            </button>
          )}

          {meetingDetail.meeting.status === "in_progress" && (
            <div className="ic-composer" style={{ padding: 0, flexWrap: "wrap" }}>
              <label className="ic-sr-only" htmlFor="ic-meeting-minutes">
                Protokoll
              </label>
              <input
                id="ic-meeting-minutes"
                data-testid="meeting-minutes"
                placeholder="Protokoll / Ergebnis"
                value={meetingMinutesDraft}
                onChange={(e) => setMeetingMinutesDraft(e.target.value)}
              />
              <button
                type="button"
                className="ic-btn"
                data-testid="meeting-end"
                disabled={busy}
                onClick={() => endMeeting(meetingDetail.meeting.id, meetingMinutesDraft)}
              >
                Beenden
              </button>
            </div>
          )}

          <h3 className="ic-section-title" style={{ padding: "8px 0 4px" }}>
            Aktionspunkte
          </h3>
          {meetingDetail.actionItems.length === 0 && <p className="ic-empty">—</p>}
          <ul className="ic-milestone-list">
            {meetingDetail.actionItems.map((item) => (
              <li key={item.id} data-testid={`action-item-${item.id}`}>
                <span className="ic-milestone-title">{item.description}</span>
                {item.task_id ? (
                  <span className="ic-tag" data-tone="policy">
                    Aufgabe angelegt
                  </span>
                ) : (
                  <button type="button" className="ic-btn" disabled={busy} onClick={() => convertActionItem(item.id)}>
                    Als Aufgabe anlegen
                  </button>
                )}
              </li>
            ))}
          </ul>
          <div className="ic-composer" style={{ padding: 0, flexWrap: "wrap" }}>
            <label className="ic-sr-only" htmlFor="ic-new-action-item">
              Neuer Aktionspunkt
            </label>
            <input
              id="ic-new-action-item"
              data-testid="new-action-item-description"
              placeholder="Neuer Aktionspunkt"
              value={newActionItemDescription}
              onChange={(e) => setNewActionItemDescription(e.target.value)}
            />
            <label className="ic-sr-only" htmlFor="ic-new-action-item-assignee">
              Zuständig
            </label>
            <select
              id="ic-new-action-item-assignee"
              className="ic-select"
              data-testid="new-action-item-assignee"
              value={newActionItemAssigneeId}
              onChange={(e) => setNewActionItemAssigneeId(e.target.value)}
            >
              <option value="">Niemand zugewiesen</option>
              {meetingDetail.participants.map((p) => (
                <option key={p.agent_id} value={p.agent_id}>
                  {p.display_name}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="ic-btn"
              data-testid="new-action-item-submit"
              disabled={busy || !newActionItemDescription.trim()}
              onClick={() => addMeetingActionItem(meetingDetail.meeting.id)}
            >
              Hinzufügen
            </button>
          </div>
        </DetailDialog>
      )}

      {showMemory && (
        <DetailDialog title="Wissen" onClose={() => setShowMemory(false)}>
          <p className="ic-note">
            Ein Obsidian-Vault ist ein Ordner voller Markdown-Dateien — jede Notiz hier ist eine echte .md-Datei mit
            YAML-Frontmatter, direkt in Obsidian zu öffnen.
          </p>

          <h3 className="ic-section-title" style={{ padding: "8px 0 4px" }}>
            Anbieter
          </h3>
          {memoryProviders.length === 0 && <p className="ic-empty">Kein MemoryProvider registriert.</p>}
          <ul className="ic-milestone-list">
            {memoryProviders.map((p) => (
              <li key={p.kind} data-testid={`memory-provider-${p.kind}`}>
                <span className="ic-milestone-title">{p.kind}</span>
                <span className="ic-tag" data-tone={p.ok ? "policy" : "gate"}>
                  {p.ok ? "verbunden" : "nicht erreichbar"}
                </span>
                <span className="ic-note">{p.message}</span>
              </li>
            ))}
          </ul>

          <h3 className="ic-section-title" style={{ padding: "8px 0 4px" }}>
            Suche
          </h3>
          <div className="ic-composer" style={{ padding: 0, flexWrap: "wrap" }}>
            <label className="ic-sr-only" htmlFor="ic-memory-search">
              Suche
            </label>
            <input
              id="ic-memory-search"
              data-testid="memory-search-input"
              placeholder="Volltextsuche im Vault"
              value={memoryQuery}
              onChange={(e) => setMemoryQuery(e.target.value)}
            />
            <button
              type="button"
              className="ic-btn"
              data-testid="memory-search-submit"
              disabled={busy || !memoryQuery.trim() || memoryProviders.length === 0}
              onClick={searchMemory}
            >
              Suchen
            </button>
          </div>
          {memorySearchHits && (
            <ul className="ic-milestone-list" data-testid="memory-search-results">
              {memorySearchHits.length === 0 && <p className="ic-empty">Keine Treffer.</p>}
              {memorySearchHits.map((hit) => (
                <li key={hit.externalId}>
                  <span className="ic-milestone-title">{hit.title}</span>
                  <span className="ic-note">{hit.snippet}</span>
                </li>
              ))}
            </ul>
          )}

          <h3 className="ic-section-title" style={{ padding: "8px 0 4px" }}>
            Einträge
          </h3>
          {memories.length === 0 && <p className="ic-empty">Noch keine Einträge.</p>}
          <ul className="ic-milestone-list">
            {memories.map((m) => (
              <li key={m.id} data-testid={`memory-${m.id}`}>
                <span className="ic-milestone-title">{m.title}</span>
                <span className="ic-tag" data-tone="policy">
                  {MEMORY_KIND_LABEL[m.kind]}
                </span>
                <button type="button" className="ic-btn" disabled={busy} onClick={() => openMemoryDetail(m.id)}>
                  Öffnen
                </button>
                <button
                  type="button"
                  className="ic-btn"
                  data-variant="danger"
                  disabled={busy}
                  onClick={() => deleteMemoryEntry(m.id)}
                >
                  Löschen
                </button>
              </li>
            ))}
          </ul>

          {memoryDetail && (
            <div data-testid="memory-detail">
              <h3 className="ic-section-title" style={{ padding: "8px 0 4px" }}>
                {memoryDetail.memory.title}
              </h3>
              <pre className="ic-note" style={{ whiteSpace: "pre-wrap" }}>
                {memoryDetail.content}
              </pre>
              <button type="button" className="ic-btn" onClick={() => setMemoryDetail(null)}>
                Schließen
              </button>
            </div>
          )}

          <h3 className="ic-section-title" style={{ padding: "8px 0 4px" }}>
            Neue Notiz
          </h3>
          <div className="ic-composer" style={{ padding: 0, flexWrap: "wrap" }}>
            <label className="ic-sr-only" htmlFor="ic-new-memory-kind">
              Art
            </label>
            <select
              id="ic-new-memory-kind"
              className="ic-select"
              data-testid="new-memory-kind"
              value={newMemoryKind}
              onChange={(e) => setNewMemoryKind(e.target.value as MemoryKind)}
            >
              {(Object.keys(MEMORY_KIND_LABEL) as MemoryKind[]).map((k) => (
                <option key={k} value={k}>
                  {MEMORY_KIND_LABEL[k]}
                </option>
              ))}
            </select>
            <label className="ic-sr-only" htmlFor="ic-new-memory-title">
              Titel
            </label>
            <input
              id="ic-new-memory-title"
              data-testid="new-memory-title"
              placeholder="Titel"
              value={newMemoryTitle}
              onChange={(e) => setNewMemoryTitle(e.target.value)}
            />
          </div>
          <div className="ic-composer" style={{ padding: 0 }}>
            <label className="ic-sr-only" htmlFor="ic-new-memory-content">
              Inhalt
            </label>
            <textarea
              id="ic-new-memory-content"
              data-testid="new-memory-content"
              placeholder="Inhalt (Markdown)"
              rows={4}
              value={newMemoryContent}
              onChange={(e) => setNewMemoryContent(e.target.value)}
            />
            <button
              type="button"
              className="ic-btn"
              data-variant="primary"
              data-testid="new-memory-submit"
              disabled={busy || !newMemoryTitle.trim() || !newMemoryContent.trim() || memoryProviders.length === 0}
              onClick={recordMemory}
            >
              Speichern
            </button>
          </div>
        </DetailDialog>
      )}

      {showChannels && (
        <DetailDialog title="Kanäle" onClose={() => setShowChannels(false)}>
          <p className="ic-note">
            Fan-out für den Entscheidungs-Posteingang (aktuell: Freigabeanfragen) an Discord, Telegram und E-Mail. Ein
            Kanal wird beim Serverstart aus Umgebungsvariablen registriert — hier lässt sich nur prüfen, ob er wirklich
            funktioniert.
          </p>
          {notificationChannels.length === 0 && <p className="ic-empty">Kein Kanal registriert.</p>}
          <ul className="ic-milestone-list">
            {notificationChannels.map((c) => (
              <li key={c.kind} data-testid={`channel-${c.kind}`}>
                <span className="ic-milestone-title">{NOTIFICATION_CHANNEL_LABEL[c.kind] ?? c.kind}</span>
                <span className="ic-tag" data-tone={c.ok ? "policy" : "gate"}>
                  {c.ok ? "verbunden" : "nicht erreichbar"}
                </span>
                <span className="ic-note">{c.message}</span>
                <button type="button" className="ic-btn" disabled={busy} onClick={() => testChannel(c.kind)}>
                  Testen
                </button>
                <button type="button" className="ic-btn" disabled={busy} onClick={() => sendTestNotification(c.kind)}>
                  Testnachricht senden
                </button>
                {channelTestResults[c.kind] && (
                  <span
                    className="ic-tag"
                    data-testid={`channel-test-${c.kind}`}
                    data-tone={channelTestResults[c.kind].ok ? "policy" : "gate"}
                  >
                    {channelTestResults[c.kind].message}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </DetailDialog>
      )}
    </div>
  );
}

function AttachmentSection({
  title,
  attachments,
  busy,
  onUpload,
  onDelete,
  downloadUrl,
}: {
  title: string;
  attachments: Attachment[];
  busy: boolean;
  onUpload: (file: File) => void;
  onDelete: (id: string) => void;
  downloadUrl: (id: string) => string;
}): React.JSX.Element {
  return (
    <>
      <h3 className="ic-section-title" style={{ padding: "8px 0 4px" }}>
        {title}
      </h3>
      {attachments.length === 0 && <p className="ic-empty">—</p>}
      <ul className="ic-milestone-list">
        {attachments.map((a) => (
          <li key={a.id} data-testid={`attachment-${a.id}`}>
            <a className="ic-milestone-title" href={downloadUrl(a.id)} target="_blank" rel="noreferrer">
              {a.filename}
            </a>
            <span className="ic-tag">{formatBytes(a.size_bytes)}</span>
            <button
              type="button"
              className="ic-btn"
              data-variant="danger"
              disabled={busy}
              onClick={() => onDelete(a.id)}
            >
              Entfernen
            </button>
          </li>
        ))}
      </ul>
      <div className="ic-composer" style={{ padding: 0 }}>
        <label className="ic-sr-only" htmlFor={`ic-upload-${title}`}>
          Datei hochladen für {title}
        </label>
        <input
          id={`ic-upload-${title}`}
          type="file"
          data-testid="attachment-upload-input"
          disabled={busy}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) onUpload(file);
          }}
        />
      </div>
    </>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | string;
  tone?: "accent" | "decision" | "critical";
}): React.JSX.Element {
  return (
    <div className="ic-metric" data-tone={tone}>
      <span className="ic-metric-label">{label}</span>
      <span className="ic-metric-value">{value}</span>
    </div>
  );
}

function DetailDialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="ic-detail-backdrop" role="dialog" aria-modal="true" aria-label={title}>
      <div className="ic-detail">
        <h2>{title}</h2>
        {children}
        <button type="button" className="ic-btn" onClick={onClose}>
          Schliessen
        </button>
      </div>
    </div>
  );
}

export default CommandCenterView;
