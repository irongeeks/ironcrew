import { useCallback, useEffect, useRef, useState } from "react";
import type { WSEventType } from "../types";

type SocketOn = (event: WSEventType, handler: (payload: unknown) => void) => () => void;

interface Toast {
  id: string;
  message: string;
  type: "info" | "success" | "warning" | "error";
  timestamp: number;
  durationMs: number;
}

const MAX_TOASTS = 5;
const TOAST_DURATION_MS = 6_000;
const TOAST_DURATION_LONG_MS = 20_000;

const TYPE_STYLES: Record<Toast["type"], { bg: string; border: string; icon: string }> = {
  info: { bg: "var(--bg-surface-solid)", border: "var(--accent)", icon: "i" },
  success: { bg: "var(--bg-surface-solid)", border: "var(--status-working)", icon: "\u2713" },
  warning: { bg: "var(--bg-surface-solid)", border: "#facc15", icon: "!" },
  error: { bg: "var(--bg-surface-solid)", border: "#ef4444", icon: "\u2717" },
};

interface NotificationToastProps {
  socketOn: SocketOn;
}

export function NotificationToast({ socketOn }: NotificationToastProps) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const counterRef = useRef(0);

  const push = useCallback((message: string, type: Toast["type"] = "info", durationMs: number = TOAST_DURATION_MS) => {
    const id = `toast-${++counterRef.current}`;
    setToasts((prev) => [...prev.slice(-(MAX_TOASTS - 1)), { id, message, type, timestamp: Date.now(), durationMs }]);
  }, []);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // Auto-dismiss
  useEffect(() => {
    if (toasts.length === 0) return;
    const timer = setInterval(() => {
      const now = Date.now();
      setToasts((prev) => prev.filter((t) => now - t.timestamp < t.durationMs));
    }, 1_000);
    return () => clearInterval(timer);
  }, [toasts.length]);

  // Listen to WebSocket events
  useEffect(() => {
    const unsubs: (() => void)[] = [];

    unsubs.push(
      socketOn("task_update", (payload) => {
        const rec = payload as Record<string, unknown> | undefined;
        if (!rec) return;
        const title = (rec.title as string) || "Task";
        const status = rec.status as string;
        if (status === "review") {
          push(`"${truncate(title, 40)}" is ready for review`, "warning");
        } else if (status === "done") {
          push(`"${truncate(title, 40)}" completed`, "success");
        } else if (status === "failed") {
          push(`"${truncate(title, 40)}" failed`, "error");
        }
      }),
    );

    unsubs.push(
      socketOn("subtask_update", (payload) => {
        const rec = payload as Record<string, unknown> | undefined;
        if (!rec) return;
        const title = (rec.title as string) || "";
        const status = rec.status as string;
        if (status === "awaiting_approval" && title.startsWith("[pipeline:")) {
          const phaseId = title.replace("[pipeline:", "").replace("]", "");
          push(`Phase "${phaseId}" needs approval`, "warning");
        }
      }),
    );

    unsubs.push(
      socketOn("cli_auth_warning", (payload) => {
        const rec = (payload as Record<string, unknown>) || {};
        const provider = typeof rec.provider === "string" ? rec.provider : "CLI";
        const reason = typeof rec.reason === "string" ? rec.reason : "auth_issue";
        const readable = reason === "token_expired" ? "token expired" : reason.replace(/_/g, " ");
        push(`${provider}: ${readable}. Re-authenticate in Settings.`, "warning");
      }),
    );

    unsubs.push(
      socketOn("token_budget_warning", (payload) => {
        const rec = (payload as Record<string, unknown>) || {};
        const message = typeof rec.message === "string" ? rec.message : "Token budget running low";
        push(truncate(message, 180), "warning", TOAST_DURATION_LONG_MS);
      }),
    );

    return () => unsubs.forEach((fn) => fn());
  }, [socketOn, push]);

  if (toasts.length === 0) return null;

  return (
    <>
      <style>{`@keyframes toast-slide-in { from { opacity: 0; transform: translateX(40px); } to { opacity: 1; transform: translateX(0); } }`}</style>
      <div
        style={{
          position: "fixed",
          bottom: 16,
          right: 16,
          zIndex: 9999,
          display: "flex",
          flexDirection: "column",
          gap: 8,
          pointerEvents: "none",
          maxWidth: 360,
        }}
      >
        {toasts.map((toast) => {
          const style = TYPE_STYLES[toast.type];
          return (
            <div
              key={toast.id}
              style={{
                background: style.bg,
                border: `1px solid ${style.border}`,
                borderLeft: `3px solid ${style.border}`,
                borderRadius: 8,
                padding: "8px 12px",
                boxShadow: "0 4px 16px rgba(0,0,0,0.3)",
                pointerEvents: "auto",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: 8,
                animation: "toast-slide-in 0.25s ease-out",
              }}
              onClick={() => dismiss(toast.id)}
            >
              <span
                style={{
                  width: 18,
                  height: 18,
                  borderRadius: "50%",
                  background: `color-mix(in srgb, ${style.border} 20%, transparent)`,
                  color: style.border,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 10,
                  fontWeight: 700,
                  flexShrink: 0,
                }}
              >
                {style.icon}
              </span>
              <span style={{ color: "var(--text-primary)", fontSize: 11 }}>{toast.message}</span>
            </div>
          );
        })}
      </div>
    </>
  );
}

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max - 1) + "\u2026" : str;
}
