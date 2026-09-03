import { useEffect, useRef, useState, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useI18n } from "../../i18n";

interface CliAuthTerminalProps {
  provider: "claude" | "codex" | "gemini";
  onSuccess: () => void;
  onCancel: () => void;
}

const PROVIDER_LABELS: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex CLI",
  gemini: "Gemini CLI",
};

export default function CliAuthTerminal({ provider, onSuccess, onCancel }: CliAuthTerminalProps) {
  const { t } = useI18n();
  const termRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [status, setStatus] = useState<"connecting" | "running" | "success" | "error">("connecting");
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  /** Whether the provider was already authenticated when this terminal opened */
  const wasAuthenticatedRef = useRef<boolean | null>(null);

  // Poll detectAllCli to check when auth succeeds
  const startPolling = useCallback(() => {
    if (pollTimer.current) return;
    pollTimer.current = setInterval(async () => {
      try {
        const resp = await fetch("/api/cli-status?refresh=1");
        if (!resp.ok) return;
        const data = await resp.json();
        const providerStatus = data.providers?.[provider];

        // Snapshot initial auth state on first poll so we can detect a real transition
        if (wasAuthenticatedRef.current === null) {
          wasAuthenticatedRef.current = providerStatus?.authenticated ?? false;
          // If already authenticated, don't auto-succeed — the user explicitly
          // clicked re-authenticate, so wait for the PTY process to exit (code 0)
          return;
        }

        // Only succeed if credentials changed (was NOT authenticated, now IS)
        if (providerStatus?.authenticated && !wasAuthenticatedRef.current) {
          setStatus("success");
          if (pollTimer.current) clearInterval(pollTimer.current);
          pollTimer.current = null;
          setTimeout(onSuccess, 2000);
        }
      } catch {
        // ignore
      }
    }, 3000);
  }, [provider, onSuccess]);

  useEffect(() => {
    if (!termRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
      theme: {
        background: "#0d0d0f",
        foreground: "#e0e0e0",
        cursor: "#34D399",
        selectionBackground: "#34D39940",
      },
      cols: 80,
      rows: 20,
      convertEol: true,
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(termRef.current);

    // Small delay to let DOM settle before fitting
    requestAnimationFrame(() => {
      fit.fit();
    });

    terminalRef.current = term;
    fitRef.current = fit;

    // Connect WebSocket
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws/cli-auth/${provider}`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus("running");
      // Send initial size
      ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      startPolling();
      // Focus terminal so the user can type immediately (e.g. enter auth codes)
      requestAnimationFrame(() => term.focus());
    };

    ws.onmessage = (ev) => {
      const data = ev.data;
      // Check for JSON control messages
      if (typeof data === "string" && data.startsWith("{")) {
        try {
          const msg = JSON.parse(data);
          if (msg.type === "exit") {
            term.writeln(`\r\n\x1b[90m[Process exited with code ${msg.code}]\x1b[0m`);
            if (pollTimer.current) clearInterval(pollTimer.current);
            pollTimer.current = null;
            if (msg.code === 0) {
              setStatus("success");
              setTimeout(onSuccess, 2000);
            } else {
              setStatus("error");
            }
            return;
          }
          if (msg.type === "error") {
            term.writeln(`\r\n\x1b[31m${msg.message}\x1b[0m`);
            return;
          }
        } catch {
          // Not JSON — regular terminal output
        }
      }
      term.write(typeof data === "string" ? data : new Uint8Array(data));
    };

    ws.onclose = () => {
      term.writeln("\r\n\x1b[90m[Disconnected]\x1b[0m");
      if (pollTimer.current) clearInterval(pollTimer.current);
      pollTimer.current = null;
      // If we never reached success, surface an error so the UI isn't stuck
      setStatus((prev) => (prev === "success" ? prev : "error"));
    };

    ws.onerror = () => {
      setStatus("error");
    };

    // Terminal input → WebSocket
    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });

    // Handle resize
    const resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        fit.fit();
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
        }
      });
    });
    resizeObserver.observe(termRef.current);

    return () => {
      resizeObserver.disconnect();
      if (pollTimer.current) clearInterval(pollTimer.current);
      ws.close();
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);

  const handleCancel = () => {
    wsRef.current?.close();
    if (pollTimer.current) clearInterval(pollTimer.current);
    onCancel();
  };

  const label = PROVIDER_LABELS[provider] ?? provider;

  return (
    <div className="space-y-3">
      {status === "success" && (
        <div className="rounded-lg border border-green-500/20 bg-green-500/10 px-3 py-2 text-xs text-green-400">
          {t({
            ko: `${label} 인증 완료!`,
            en: `${label} authenticated successfully!`,
            ja: `${label} 認証完了！`,
            zh: `${label} authenticated successfully!`,
            de: `${label} erfolgreich authentifiziert!`,
          })}
        </div>
      )}

      <div
        ref={termRef}
        onClick={() => terminalRef.current?.focus()}
        style={{
          height: 360,
          borderRadius: 8,
          overflow: "hidden",
          border: "1px solid var(--th-border)",
          cursor: "text",
        }}
      />

      {status === "error" && (
        <div className="rounded-lg border border-rose-500/60 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
          {t({
            ko: "인증에 실패했습니다. 다시 시도하거나 터미널에서 직접 로그인하세요.",
            en: "Authentication failed. Try again or log in directly from a terminal.",
            ja: "認証に失敗しました。再試行するか、ターミナルから直接ログインしてください。",
            zh: "Authentication failed. Try again or log in directly from a terminal.",
            de: "Authentifizierung fehlgeschlagen. Versuchen Sie es erneut oder melden Sie sich direkt im Terminal an.",
          })}
        </div>
      )}

      {status !== "success" && (
        <div className="flex items-center justify-between">
          <p className="text-[11px]" style={{ color: "var(--th-text-muted)" }}>
            {status === "error"
              ? t({
                  ko: "터미널에서 오류가 발생했습니다.",
                  en: "The terminal session ended with an error.",
                  ja: "ターミナルセッションがエラーで終了しました。",
                  zh: "The terminal session ended with an error.",
                  de: "Die Terminalsitzung wurde mit einem Fehler beendet.",
                })
              : t({
                  ko: "터미널을 클릭하고 표시된 코드를 입력하세요.",
                  en: "Click the terminal and type any code shown there.",
                  ja: "ターミナルをクリックして、表示されたコードを入力してください。",
                  zh: "Click the terminal and type any code shown there.",
                  de: "Klicken Sie ins Terminal und geben Sie den angezeigten Code ein.",
                })}
          </p>
          <button
            type="button"
            onClick={handleCancel}
            className="rounded-lg border px-3 py-1.5 text-xs"
            style={{ borderColor: "var(--th-border)", color: "var(--th-text-secondary)" }}
          >
            {t({ ko: "취소", en: "Cancel", ja: "キャンセル", zh: "Cancel", de: "Abbrechen" })}
          </button>
        </div>
      )}
    </div>
  );
}
