import { useState, useEffect, useRef, useCallback } from "react";
import type { MeetingMinute } from "../../types";
import { getTerminal, getTaskMeetingMinutes } from "../../api";
import type { TerminalProgressHintsPayload } from "../../api";
import { TERMINAL_TAIL_LINES, TERMINAL_TASK_LOG_LIMIT, type TaskLogEntry } from "./model";

export interface InterruptProof {
  session_id: string;
  control_token: string;
  requires_csrf: boolean;
}

export function useTerminalData(
  taskId: string,
  activeTab: "terminal" | "minutes",
  onInterruptProofReceived: (proof: InterruptProof | null) => void,
) {
  const [text, setText] = useState("");
  const [taskLogs, setTaskLogs] = useState<TaskLogEntry[]>([]);
  const [progressHints, setProgressHints] = useState<TerminalProgressHintsPayload | null>(null);
  const [meetingMinutes, setMeetingMinutes] = useState<MeetingMinute[]>([]);
  const [logPath, setLogPath] = useState("");
  const [follow, setFollow] = useState(true);
  const preRef = useRef<HTMLPreElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Poll terminal endpoint every 1.5s
  const fetchTerminal = useCallback(async () => {
    try {
      const res = await getTerminal(taskId, TERMINAL_TAIL_LINES, true, TERMINAL_TASK_LOG_LIMIT);
      if (res.ok) {
        setLogPath(res.path);
        if (res.task_logs) {
          setTaskLogs((prev) => {
            const next = res.task_logs ?? [];
            const prevLast = prev.length > 0 ? prev[prev.length - 1].id : null;
            const nextLast = next.length > 0 ? next[next.length - 1].id : null;
            if (prev.length === next.length && prevLast === nextLast) return prev;
            return next;
          });
        }
        setProgressHints(res.progress_hints ?? null);
        onInterruptProofReceived(res.interrupt ?? null);
        if (res.exists) {
          const nextText = res.text ?? "";
          setText((prev) => (prev === nextText ? prev : nextText));
        } else {
          setText((prev) => (prev === "" ? prev : ""));
        }
      }
    } catch {
      // ignore
    }
  }, [taskId, onInterruptProofReceived]);

  const fetchMeetingMinutes = useCallback(async () => {
    try {
      const rows = await getTaskMeetingMinutes(taskId);
      setMeetingMinutes(rows);
    } catch {
      // ignore
    }
    // Also fetch task logs for fallback display when no minutes exist
    try {
      const res = await getTerminal(taskId, 0, true, 30);
      if (res.ok && res.task_logs) {
        setTaskLogs((prev) => {
          const next = res.task_logs ?? [];
          const prevLast = prev.length > 0 ? prev[prev.length - 1].id : null;
          const nextLast = next.length > 0 ? next[next.length - 1].id : null;
          if (prev.length === next.length && prevLast === nextLast) return prev;
          return next;
        });
      }
    } catch {
      // ignore
    }
  }, [taskId]);

  useEffect(() => {
    const fn = activeTab === "terminal" ? fetchTerminal : fetchMeetingMinutes;
    const ms = activeTab === "terminal" ? 1500 : 2500;
    fn();
    let timer: ReturnType<typeof setInterval>;
    function start() {
      timer = setInterval(fn, ms);
    }
    function handleVisibility() {
      clearInterval(timer);
      if (!document.hidden) {
        fn();
        start();
      }
    }
    start();
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [activeTab, fetchTerminal, fetchMeetingMinutes]);

  // Auto-scroll when follow is enabled
  useEffect(() => {
    if (follow && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [text, follow]);

  // Detect if user scrolled away from bottom
  function handleScroll() {
    if (!containerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    const atBottom = scrollHeight - scrollTop - clientHeight < 50;
    if (!atBottom && follow) setFollow(false);
  }

  function scrollToBottom() {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
      setFollow(true);
    }
  }

  return {
    text,
    taskLogs,
    progressHints,
    meetingMinutes,
    logPath,
    follow,
    setFollow,
    preRef,
    containerRef,
    fetchTerminal,
    fetchMeetingMinutes,
    handleScroll,
    scrollToBottom,
  };
}
