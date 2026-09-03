import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import type { Agent, SubTask, Task, WSEventType } from "../../types";
import AgentTabs from "./AgentTabs";
import TaskContextBar from "./TaskContextBar";
import ActivityTimeline from "./ActivityTimeline";
import TerminalPanel from "./TerminalPanel";

const MAX_STREAM_CHARS = 16_000;

interface LiveTaskViewProps {
  agents: Agent[];
  tasks: Task[];
  subtasks: SubTask[];
  socketOn: (event: WSEventType, handler: (payload: unknown) => void) => () => void;
}

export default function LiveTaskView({ agents, tasks, subtasks, socketOn }: LiveTaskViewProps) {
  const workingAgents = useMemo(() => agents.filter((a) => a.status === "working"), [agents]);

  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);

  const activeAgentId = useMemo(() => {
    if (selectedAgentId && workingAgents.some((a) => a.id === selectedAgentId)) {
      return selectedAgentId;
    }
    return workingAgents[0]?.id ?? null;
  }, [selectedAgentId, workingAgents]);

  const activeAgent = useMemo(() => agents.find((a) => a.id === activeAgentId) ?? null, [agents, activeAgentId]);

  const activeTaskId = activeAgent?.current_task_id ?? null;

  const activeTask = useMemo(() => {
    if (!activeTaskId) return null;
    return tasks.find((t) => t.id === activeTaskId) ?? null;
  }, [activeTaskId, tasks]);

  // Accumulate CLI output per task via WebSocket subscription
  const streamBufferRef = useRef<Map<string, string>>(new Map());
  const [streamTail, setStreamTail] = useState("");

  const handleCliOutput = useCallback((payload: unknown) => {
    const p = payload as { task_id?: string; data?: string };
    if (!p?.task_id || !p?.data) return;
    const prev = streamBufferRef.current.get(p.task_id) ?? "";
    let next = prev + p.data;
    if (next.length > MAX_STREAM_CHARS) {
      next = next.slice(next.length - MAX_STREAM_CHARS);
    }
    streamBufferRef.current.set(p.task_id, next);
  }, []);

  useEffect(() => {
    return socketOn("cli_output", handleCliOutput);
  }, [socketOn, handleCliOutput]);

  // Seed buffer from historical log when task changes, then keep syncing on interval
  useEffect(() => {
    if (!activeTaskId) {
      setStreamTail("");
      return;
    }

    let cancelled = false;

    fetch(`/api/tasks/${activeTaskId}/terminal?lines=200`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data: { ok?: boolean; text?: string }) => {
        if (!cancelled && data.ok && data.text) {
          const existing = streamBufferRef.current.get(activeTaskId) ?? "";
          if (!existing) {
            let seeded = data.text;
            if (seeded.length > MAX_STREAM_CHARS) seeded = seeded.slice(seeded.length - MAX_STREAM_CHARS);
            streamBufferRef.current.set(activeTaskId, seeded);
          }
        }
      })
      .catch(() => {
        // ignore fetch errors — WS events will populate the buffer
      });

    const read = () => setStreamTail(streamBufferRef.current.get(activeTaskId) ?? "");
    read();
    const id = setInterval(read, 500);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [activeTaskId]);

  if (workingAgents.length === 0) {
    return (
      <div
        style={{
          width: 380,
          flexShrink: 0,
          background: "var(--bg-surface-solid)",
          borderRadius: 8,
          border: "1px solid var(--border)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexDirection: "column",
          gap: 8,
        }}
      >
        <span
          style={{
            fontFamily: "JetBrains Mono, monospace",
            fontSize: 10,
            color: "var(--text-muted)",
            opacity: 0.5,
          }}
        >
          No active agents
        </span>
      </div>
    );
  }

  return (
    <div
      style={{
        width: 380,
        flexShrink: 0,
        background: "var(--bg-surface-solid)",
        borderRadius: 8,
        border: "1px solid var(--border)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <AgentTabs agents={workingAgents} activeAgentId={activeAgentId} onSelectAgent={setSelectedAgentId} />
      <TaskContextBar task={activeTask} subtasks={subtasks} />
      <ActivityTimeline subtasks={subtasks} taskId={activeTaskId} streamTail={streamTail} />
      <TerminalPanel streamTail={streamTail} />
    </div>
  );
}
