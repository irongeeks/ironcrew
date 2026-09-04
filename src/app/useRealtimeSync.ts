import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { TaskReportDetail } from "../api";
import * as api from "../api";
import type {
  Agent,
  AutonomousActionEvent,
  CrossDeptDelivery,
  MeetingPresence,
  MeetingReviewDecision,
  Message,
  SubAgent,
  SubTask,
  Task,
  CeoOfficeCall,
  WSEventType,
} from "../types";
import {
  CODEX_THREAD_BINDING_TTL_MS,
  MAX_CEO_OFFICE_CALLS,
  MAX_CODEX_THREAD_BINDINGS,
  MAX_CROSS_DEPT_DELIVERIES,
  MAX_LIVE_MESSAGES,
  MAX_LIVE_SUBAGENTS,
  MAX_LIVE_SUBTASKS,
  MAX_SUBAGENT_STREAM_TAIL_CHARS,
  MAX_SUBAGENT_STREAM_TRACKED_TASKS,
} from "./constants";
import { parseCliSubAgentEvents, shouldParseCliChunkForSubAgents } from "./sub-agent-events";
import type { View } from "./types";
import { appendCapped, areAgentsEquivalent } from "./utils";
import { asRecord, asRecordOrEmpty, requireStringFields, strOrNull, numOrNull } from "./ws-payload-guards";

type SocketOn = (event: WSEventType, handler: (payload: unknown) => void) => () => void;

interface UseRealtimeSyncParams {
  on: SocketOn;
  scheduleLiveSync: (delayMs?: number) => void;
  agentsRef: MutableRefObject<Agent[]>;
  tasksRef: MutableRefObject<Task[]>;
  subAgentsRef: MutableRefObject<SubAgent[]>;
  viewRef: MutableRefObject<View>;
  activeChatRef: MutableRefObject<{ showChat: boolean; agentId: string | null }>;
  codexThreadToSubAgentIdRef: MutableRefObject<Map<string, string>>;
  codexThreadBindingTsRef: MutableRefObject<Map<string, number>>;
  subAgentStreamTailRef: MutableRefObject<Map<string, string>>;
  setAgents: Dispatch<SetStateAction<Agent[]>>;
  setMessages: Dispatch<SetStateAction<Message[]>>;
  setUnreadAgentIds: Dispatch<SetStateAction<Set<string>>>;
  setTaskReport: Dispatch<SetStateAction<TaskReportDetail | null>>;
  setCrossDeptDeliveries: Dispatch<SetStateAction<CrossDeptDelivery[]>>;
  setCeoOfficeCalls: Dispatch<SetStateAction<CeoOfficeCall[]>>;
  setMeetingPresence: Dispatch<SetStateAction<MeetingPresence[]>>;
  setSubtasks: Dispatch<SetStateAction<SubTask[]>>;
  setSubAgents: Dispatch<SetStateAction<SubAgent[]>>;
  setStreamingMessage: Dispatch<
    SetStateAction<{
      message_id: string;
      agent_id: string;
      agent_name: string;
      agent_avatar: string;
      content: string;
    } | null>
  >;
  setAutonomousActions?: Dispatch<SetStateAction<AutonomousActionEvent[]>>;
}

export function useRealtimeSync({
  on,
  scheduleLiveSync,
  agentsRef,
  tasksRef,
  subAgentsRef,
  viewRef,
  activeChatRef,
  codexThreadToSubAgentIdRef,
  codexThreadBindingTsRef,
  subAgentStreamTailRef,
  setAgents,
  setMessages,
  setUnreadAgentIds,
  setTaskReport,
  setCrossDeptDeliveries,
  setCeoOfficeCalls,
  setMeetingPresence,
  setSubtasks,
  setSubAgents,
  setStreamingMessage,
  setAutonomousActions,
}: UseRealtimeSyncParams): void {
  useEffect(() => {
    const unsubs = [
      on("task_update", () => {
        scheduleLiveSync(80);
      }),
      on("agent_status", (payload: unknown) => {
        const raw = asRecord(payload);
        if (!raw || typeof raw.id !== "string") return;
        const p = raw as unknown as Agent & { subAgents?: SubAgent[] };
        const { subAgents: incomingSubAgents, ...agentPatch } = p;
        const hasKnownAgent = agentsRef.current.some((a) => a.id === agentPatch.id);
        if (!hasKnownAgent) {
          scheduleLiveSync(80);
          return;
        }
        setAgents((prev) => {
          const idx = prev.findIndex((a) => a.id === agentPatch.id);
          if (idx < 0) return prev;
          const current = prev[idx];
          const merged = { ...current, ...agentPatch };
          if (areAgentsEquivalent(current, merged)) return prev;
          const next = [...prev];
          next[idx] = merged;
          return next;
        });
        if (incomingSubAgents) {
          setSubAgents((prev) => {
            const others = prev.filter((s) => s.parentAgentId !== p.id);
            const next = [...others, ...incomingSubAgents];
            return next.length > MAX_LIVE_SUBAGENTS ? next.slice(next.length - MAX_LIVE_SUBAGENTS) : next;
          });
        }
      }),
      on("agent_created", () => {
        scheduleLiveSync(60);
      }),
      on("agent_deleted", () => {
        scheduleLiveSync(60);
      }),
      on("departments_changed", () => {
        scheduleLiveSync(60);
      }),
      on("new_message", (payload: unknown) => {
        const raw = requireStringFields(payload, "id", "content");
        if (!raw) return;
        const msg = raw as unknown as Message;
        setMessages((prev) => {
          if (prev.some((m) => m.id === msg.id)) return prev;
          return appendCapped(prev, msg, MAX_LIVE_MESSAGES);
        });
        if (msg.sender_type === "agent" && msg.sender_id) {
          const { showChat: chatOpen, agentId: activeId } = activeChatRef.current;
          if (chatOpen && activeId === msg.sender_id) return;
          setUnreadAgentIds((prev) => {
            if (prev.has(msg.sender_id!)) return prev;
            const next = new Set(prev);
            next.add(msg.sender_id!);
            return next;
          });
        }
      }),
      on("announcement", (payload: unknown) => {
        const raw = requireStringFields(payload, "id", "content");
        if (!raw) return;
        const msg = raw as unknown as Message;
        setMessages((prev) => {
          if (prev.some((m) => m.id === msg.id)) return prev;
          return appendCapped(prev, msg, MAX_LIVE_MESSAGES);
        });
        if (msg.sender_type === "agent" && msg.sender_id) {
          const { showChat: chatOpen, agentId: activeId } = activeChatRef.current;
          if (chatOpen && activeId === msg.sender_id) return;
          setUnreadAgentIds((prev) => {
            if (prev.has(msg.sender_id!)) return prev;
            const next = new Set(prev);
            next.add(msg.sender_id!);
            return next;
          });
        }
      }),
      on("task_report", (payload: unknown) => {
        const p = asRecord(payload) as { task?: { id?: string } } | null;
        const reportTaskId = typeof p?.task?.id === "string" ? p.task.id : null;
        if (!reportTaskId) {
          setTaskReport(payload as TaskReportDetail);
          return;
        }
        api
          .getTaskReportDetail(reportTaskId)
          .then((detail) => setTaskReport(detail))
          .catch(() => setTaskReport(payload as TaskReportDetail));
      }),
      on("cross_dept_delivery", (payload: unknown) => {
        const p = asRecordOrEmpty(payload);
        const fromAgentId = strOrNull(p, "from_agent_id");
        const toAgentId = strOrNull(p, "to_agent_id");
        if (typeof fromAgentId !== "string" || typeof toAgentId !== "string") return;
        setCrossDeptDeliveries((prev) =>
          appendCapped(
            prev,
            {
              id: `cd-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              fromAgentId,
              toAgentId,
              taskId: strOrNull(p, "task_id"),
              taskTitle: strOrNull(p, "task_title"),
              chainId: strOrNull(p, "chain_id"),
              chainStepIndex: numOrNull(p, "chain_step_index"),
              chainStepTotal: numOrNull(p, "chain_step_total"),
              batonLabel: strOrNull(p, "baton_label"),
            },
            MAX_CROSS_DEPT_DELIVERIES,
          ),
        );
      }),
      on("ceo_office_call", (payload: unknown) => {
        const raw = requireStringFields(payload, "from_agent_id");
        if (!raw) return;
        const p = raw as Record<string, unknown> & {
          from_agent_id: string;
          seat_index?: number;
          phase?: "kickoff" | "review";
          action?: "arrive" | "speak" | "dismiss";
          line?: string;
          decision?: MeetingReviewDecision;
          task_id?: string;
          hold_until?: number;
        };
        const action = p.action ?? "arrive";
        if (action === "arrive" || action === "speak") {
          setMeetingPresence((prev) => {
            const existing = prev.find((row) => row.agent_id === p.from_agent_id);
            const rest = prev.filter((row) => row.agent_id !== p.from_agent_id);
            const holdUntil =
              action === "arrive"
                ? (p.hold_until ?? existing?.until ?? Date.now() + 600_000)
                : (existing?.until ?? Date.now() + 600_000);
            return [
              ...rest,
              {
                decision:
                  (p.phase ?? existing?.phase ?? "kickoff") === "review"
                    ? (p.decision ?? existing?.decision ?? "reviewing")
                    : null,
                agent_id: p.from_agent_id,
                seat_index: p.seat_index ?? existing?.seat_index ?? 0,
                phase: p.phase ?? existing?.phase ?? "kickoff",
                task_id: p.task_id ?? existing?.task_id ?? null,
                until: holdUntil,
              },
            ];
          });
        } else if (action === "dismiss") {
          setMeetingPresence((prev) => prev.filter((row) => row.agent_id !== p.from_agent_id));
        }
        setCeoOfficeCalls((prev) =>
          appendCapped(
            prev,
            {
              id: `ceo-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              fromAgentId: p.from_agent_id,
              seatIndex: p.seat_index ?? 0,
              phase: p.phase ?? "kickoff",
              action,
              line: p.line,
              decision: p.decision,
              taskId: p.task_id,
              holdUntil: p.hold_until,
              instant: action === "arrive" && viewRef.current !== "office",
            },
            MAX_CEO_OFFICE_CALLS,
          ),
        );
      }),
      on("subtask_update", (payload: unknown) => {
        const raw = requireStringFields(payload, "id", "task_id");
        if (!raw) return;
        const st = raw as unknown as SubTask;
        setSubtasks((prev) => {
          const idx = prev.findIndex((s) => s.id === st.id);
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = st;
            return next;
          }
          return appendCapped(prev, st, MAX_LIVE_SUBTASKS);
        });
        scheduleLiveSync(160);
      }),
      on("cli_output", (payload: unknown) => {
        const raw = requireStringFields(payload, "task_id", "data");
        if (!raw) return;
        const p = raw as { task_id: string; stream?: string; data: string };
        const threadMap = codexThreadToSubAgentIdRef.current;
        const threadTsMap = codexThreadBindingTsRef.current;
        const pruneCodexThreadBindings = (now: number) => {
          for (const [threadId, ts] of threadTsMap.entries()) {
            if (now - ts <= CODEX_THREAD_BINDING_TTL_MS) continue;
            threadTsMap.delete(threadId);
            threadMap.delete(threadId);
          }
          if (threadMap.size <= MAX_CODEX_THREAD_BINDINGS) return;
          const entries = Array.from(threadTsMap.entries()).sort((a, b) => a[1] - b[1]);
          const overflow = threadMap.size - MAX_CODEX_THREAD_BINDINGS;
          for (let i = 0; i < overflow && i < entries.length; i += 1) {
            const threadId = entries[i][0];
            threadTsMap.delete(threadId);
            threadMap.delete(threadId);
          }
        };
        const now = Date.now();
        pruneCodexThreadBindings(now);
        const tailMap = subAgentStreamTailRef.current;
        const setTaskTail = (taskId: string, rawTail: string) => {
          const trimmedTail =
            rawTail.length > MAX_SUBAGENT_STREAM_TAIL_CHARS
              ? rawTail.slice(rawTail.length - MAX_SUBAGENT_STREAM_TAIL_CHARS)
              : rawTail;
          if (!trimmedTail) {
            tailMap.delete(taskId);
            return;
          }
          if (!tailMap.has(taskId) && tailMap.size >= MAX_SUBAGENT_STREAM_TRACKED_TASKS) {
            const oldestTaskId = tailMap.keys().next().value as string | undefined;
            if (oldestTaskId) tailMap.delete(oldestTaskId);
          }
          tailMap.set(taskId, trimmedTail);
        };

        const previousTail = tailMap.get(p.task_id) ?? "";
        const combined = previousTail + p.data;
        let lines: string[] = [];
        const lastNewline = combined.lastIndexOf("\n");

        if (lastNewline < 0) {
          setTaskTail(p.task_id, combined);
          const singleLineCandidate = combined.trim();
          if (
            singleLineCandidate &&
            singleLineCandidate[0] === "{" &&
            singleLineCandidate[singleLineCandidate.length - 1] === "}" &&
            shouldParseCliChunkForSubAgents(singleLineCandidate)
          ) {
            lines = [singleLineCandidate];
            setTaskTail(p.task_id, "");
          } else {
            return;
          }
        } else {
          const completeChunk = combined.slice(0, lastNewline);
          const nextTail = combined.slice(lastNewline + 1);
          setTaskTail(p.task_id, nextTail);
          if (!shouldParseCliChunkForSubAgents(completeChunk)) return;
          lines = completeChunk.split("\n");
        }
        const knownSubAgentIds = new Set(subAgentsRef.current.map((s) => s.id));
        const doneSubAgentIds = new Set(subAgentsRef.current.filter((s) => s.status === "done").map((s) => s.id));
        let cachedParentAgentId: string | null | undefined;
        const resolveParentAgentId = () => {
          if (cachedParentAgentId !== undefined) return cachedParentAgentId;
          const byAgent = agentsRef.current.find((a) => a.current_task_id === p.task_id)?.id ?? null;
          if (byAgent) {
            cachedParentAgentId = byAgent;
            return byAgent;
          }
          const byTask = tasksRef.current.find((t) => t.id === p.task_id)?.assigned_agent_id ?? null;
          cachedParentAgentId = byTask;
          return byTask;
        };
        const upsertSubAgent = (subAgentId: string, taskLabel: string | null) => {
          knownSubAgentIds.add(subAgentId);
          doneSubAgentIds.delete(subAgentId);
          const parentAgentId = resolveParentAgentId();
          setSubAgents((prev) => {
            const idx = prev.findIndex((s) => s.id === subAgentId);
            if (idx >= 0) {
              const current = prev[idx];
              const nextTask = taskLabel ?? current.task;
              const nextParentAgentId = current.parentAgentId || parentAgentId || current.parentAgentId;
              if (current.task === nextTask && current.parentAgentId === nextParentAgentId) return prev;
              const next = [...prev];
              next[idx] = { ...current, task: nextTask, parentAgentId: nextParentAgentId };
              return next;
            }
            if (!parentAgentId) return prev;
            return appendCapped(
              prev,
              {
                id: subAgentId,
                parentAgentId,
                task: taskLabel ?? "Sub-task",
                status: "working" as const,
              },
              MAX_LIVE_SUBAGENTS,
            );
          });
        };
        const markSubAgentDone = (subAgentId: string) => {
          if (!knownSubAgentIds.has(subAgentId) || doneSubAgentIds.has(subAgentId)) return;
          doneSubAgentIds.add(subAgentId);
          for (const [threadId, mappedSubAgentId] of threadMap.entries()) {
            if (mappedSubAgentId !== subAgentId) continue;
            threadMap.delete(threadId);
            threadTsMap.delete(threadId);
          }
          setSubAgents((prev) => {
            const idx = prev.findIndex((s) => s.id === subAgentId);
            if (idx < 0 || prev[idx].status === "done") return prev;
            const next = [...prev];
            next[idx] = { ...prev[idx], status: "done" as const };
            return next;
          });
        };
        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line || line[0] !== "{") continue;
          if (!shouldParseCliChunkForSubAgents(line)) continue;
          let json: Record<string, unknown> | null = null;
          try {
            json = JSON.parse(line) as Record<string, unknown>;
          } catch {
            continue;
          }
          if (!json) continue;
          const events = parseCliSubAgentEvents(json);
          for (const event of events) {
            if (event.kind === "spawn") {
              upsertSubAgent(event.id, event.task);
              continue;
            }
            if (event.kind === "done") {
              markSubAgentDone(event.id);
              continue;
            }
            if (event.kind === "bind_thread") {
              threadMap.set(event.threadId, event.subAgentId);
              threadTsMap.set(event.threadId, now);
              if (threadMap.size > MAX_CODEX_THREAD_BINDINGS) {
                pruneCodexThreadBindings(now);
              }
              continue;
            }
            const mappedSubAgentId = threadMap.get(event.threadId);
            if (!mappedSubAgentId) continue;
            threadMap.delete(event.threadId);
            threadTsMap.delete(event.threadId);
            markSubAgentDone(mappedSubAgentId);
          }
        }
      }),
      on("clone_progress", (payload: unknown) => {
        const rec = asRecord(payload);
        if (!rec) return;
        const status = typeof rec.status === "string" ? rec.status : "";
        if (status === "error") {
          const err = typeof rec.error === "string" ? rec.error : "unknown error";
          console.warn("[github] clone failed:", err);
        } else if (status === "done") {
          console.info("[github] clone complete:", rec.clone_id);
        }
        // GitHubImportPanel also polls HTTP; no additional state sync needed here.
      }),
      on("messages_cleared", () => {
        // Re-fetch recent messages so all open chat panels drop cleared entries.
        api
          .getMessages({ receiver_type: "all", limit: 50 })
          .then((msgs) => setMessages(msgs))
          .catch(() => {
            // On failure, at least clear local state to avoid stale data
            setMessages([]);
          });
      }),
      on("scheduled_task_updated", () => {
        // SchedulesView listens for this custom event and re-fetches.
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("ironcrew:schedules-changed"));
        }
      }),
      on("task_interrupt", () => {
        // Inject/cancel actions change task state indirectly; refresh tasks.
        scheduleLiveSync(120);
      }),
      on("tasks_changed", () => {
        scheduleLiveSync(80);
      }),
      on("autonomous_action", (payload: unknown) => {
        if (setAutonomousActions) {
          const raw = asRecord(payload);
          if (!raw) return;
          const event = raw as unknown as AutonomousActionEvent;
          setAutonomousActions((prev) => {
            const next = [...prev, event];
            return next.length > 50 ? next.slice(-50) : next;
          });
        }
      }),
      on("chat_stream", (payload: unknown) => {
        const raw = requireStringFields(payload, "phase", "message_id", "agent_id");
        if (!raw) return;
        const p = raw as Record<string, unknown> & {
          phase: "start" | "delta" | "end";
          message_id: string;
          agent_id: string;
          agent_name?: string;
          agent_avatar?: string;
          text?: string;
          content?: string;
          created_at?: number;
        };
        if (p.phase === "start") {
          setStreamingMessage({
            message_id: p.message_id,
            agent_id: p.agent_id,
            agent_name: p.agent_name ?? "",
            agent_avatar: p.agent_avatar ?? "",
            content: "",
          });
        } else if (p.phase === "delta") {
          setStreamingMessage((prev) => {
            if (!prev || prev.message_id !== p.message_id) return prev;
            return { ...prev, content: prev.content + (p.text ?? "") };
          });
        } else if (p.phase === "end") {
          setStreamingMessage(null);
          if (p.content && p.message_id) {
            const finalMsg: Message = {
              id: p.message_id,
              sender_type: "agent",
              sender_id: p.agent_id,
              receiver_type: "agent",
              receiver_id: null,
              content: p.content,
              message_type: "chat",
              task_id: null,
              created_at: p.created_at ?? Date.now(),
            };
            setMessages((prev) => {
              if (prev.some((m) => m.id === finalMsg.id)) return prev;
              return appendCapped(prev, finalMsg, MAX_LIVE_MESSAGES);
            });
          }
        }
      }),
    ];
    return () => unsubs.forEach((fn) => fn());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, scheduleLiveSync]);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval>;
    function start() {
      timer = setInterval(() => scheduleLiveSync(0), 5000);
    }
    function handleVisibility() {
      clearInterval(timer);
      if (!document.hidden) {
        scheduleLiveSync(0);
        start();
      }
    }
    start();
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [scheduleLiveSync]);
}
