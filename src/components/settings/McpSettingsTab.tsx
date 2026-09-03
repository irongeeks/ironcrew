import { useCallback, useEffect, useState } from "react";
import type { TFunction } from "./types";
import {
  fetchMcpServers,
  addMcpServer,
  deleteMcpServer,
  testMcpServer,
  connectMcpServer,
  disconnectMcpServer,
  type McpServerStatus,
  type McpServerConfig,
} from "../../api/mcp-servers";

interface McpSettingsTabProps {
  t: TFunction;
}

const EMPTY_CONFIG: McpServerConfig = {
  name: "",
  label: "",
  transport: "stdio",
  command: "",
  args: [],
  url: "",
  enabled: true,
  autoConnect: true,
  timeout_ms: 30_000,
};

export default function McpSettingsTab({ t }: McpSettingsTabProps) {
  const [servers, setServers] = useState<McpServerStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [addMode, setAddMode] = useState(false);
  const [draft, setDraft] = useState<McpServerConfig>({ ...EMPTY_CONFIG });
  const [saving, setSaving] = useState(false);
  const [testingServer, setTestingServer] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; message: string }>>({});
  const [expandedServer, setExpandedServer] = useState<string | null>(null);
  const [argsText, setArgsText] = useState("");
  const [addError, setAddError] = useState<string | null>(null);

  const loadServers = useCallback(async () => {
    try {
      const res = await fetchMcpServers();
      setServers(res.servers);
    } catch (err) {
      console.error("[MCP] Failed to load MCP servers:", err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadServers();
  }, [loadServers]);

  const handleAdd = async () => {
    if (!draft.name.trim()) return;
    setSaving(true);
    setAddError(null);
    try {
      const config = {
        ...draft,
        args: argsText
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean),
      };
      await addMcpServer(config);
      setAddMode(false);
      setDraft({ ...EMPTY_CONFIG });
      setArgsText("");
      await loadServers();
    } catch (err) {
      setAddError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (name: string) => {
    if (
      !window.confirm(
        t({
          ko: `"${name}" 서버를 삭제하시겠습니까?`,
          en: `Delete MCP server "${name}"?`,
          ja: `"${name}" サーバーを削除しますか?`,
          zh: `Delete MCP server "${name}"?`,
          de: `MCP-Server "${name}" löschen?`,
        }),
      )
    ) {
      return;
    }
    try {
      await deleteMcpServer(name);
      await loadServers();
    } catch (err) {
      console.error("Failed to delete MCP server:", err);
    }
  };

  const handleTest = async (name: string) => {
    setTestingServer(name);
    try {
      const result = await testMcpServer(name);
      setTestResults((prev) => ({ ...prev, [name]: result }));
    } catch (err) {
      setTestResults((prev) => ({
        ...prev,
        [name]: { ok: false, message: err instanceof Error ? err.message : String(err) },
      }));
    } finally {
      setTestingServer(null);
    }
  };

  const [actionError, setActionError] = useState<string | null>(null);

  const handleConnect = async (name: string) => {
    setActionError(null);
    try {
      const res = await connectMcpServer(name);
      // Backend sends the specific failure reason in `message` (e.g. "ENOENT: spawn
      // claude-mcp"), while `error` is an opaque code ("connect_failed"). Prefer the
      // message so the UI shows something actionable.
      if (!res.ok) setActionError(res.message ?? res.error ?? "Connection failed");
      await loadServers();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDisconnect = async (name: string) => {
    setActionError(null);
    try {
      await disconnectMcpServer(name);
      await loadServers();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12" style={{ color: "var(--th-text-secondary)" }}>
        {t({ ko: "로딩 중...", en: "Loading...", ja: "読み込み中...", zh: "Loading...", de: "Laden..." })}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold" style={{ color: "var(--th-text-primary)" }}>
            {t({ ko: "MCP 서버", en: "MCP Servers", ja: "MCP サーバー", zh: "MCP Servers", de: "MCP-Server" })}
          </h3>
          <p className="mt-0.5 text-xs" style={{ color: "var(--th-text-secondary)" }}>
            {t({
              ko: "외부 MCP 서버에 연결하여 도구를 워크플로우에 사용할 수 있습니다",
              en: "Connect to external MCP servers to use their tools in workflows",
              ja: "外部 MCP サーバーに接続してワークフローでツールを使用",
              zh: "Connect to external MCP servers to use their tools in workflows",
              de: "Externe MCP-Server verbinden um deren Tools in Workflows zu nutzen",
            })}
          </p>
        </div>
        <button
          onClick={() => setAddMode(!addMode)}
          className="rounded-lg px-3 py-1.5 text-xs font-medium text-white transition-colors"
          style={{ background: "var(--th-accent, #3b82f6)" }}
        >
          {addMode
            ? t({ ko: "취소", en: "Cancel", ja: "キャンセル", zh: "Cancel", de: "Abbrechen" })
            : t({ ko: "추가", en: "Add Server", ja: "追加", zh: "Add Server", de: "Server hinzufügen" })}
        </button>
      </div>

      {/* Add form */}
      {addMode && (
        <div
          className="rounded-lg border p-4 space-y-3"
          style={{ borderColor: "var(--th-border)", background: "var(--th-bg-secondary)" }}
        >
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: "var(--th-text-secondary)" }}>
                {t({ ko: "이름", en: "Name", ja: "名前", zh: "Name", de: "Name" })}
              </label>
              <input
                className="w-full rounded border px-2 py-1.5 text-sm"
                style={{
                  borderColor: "var(--th-border)",
                  background: "var(--th-bg-primary)",
                  color: "var(--th-text-primary)",
                }}
                placeholder="my-server"
                value={draft.name}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, name: e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, "") }))
                }
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: "var(--th-text-secondary)" }}>
                {t({ ko: "레이블", en: "Label", ja: "ラベル", zh: "Label", de: "Label" })}
              </label>
              <input
                className="w-full rounded border px-2 py-1.5 text-sm"
                style={{
                  borderColor: "var(--th-border)",
                  background: "var(--th-bg-primary)",
                  color: "var(--th-text-primary)",
                }}
                placeholder="My MCP Server"
                value={draft.label ?? ""}
                onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))}
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium mb-1" style={{ color: "var(--th-text-secondary)" }}>
              {t({ ko: "전송 방식", en: "Transport", ja: "トランスポート", zh: "Transport", de: "Transport" })}
            </label>
            <select
              className="rounded border px-2 py-1.5 text-sm"
              style={{
                borderColor: "var(--th-border)",
                background: "var(--th-bg-primary)",
                color: "var(--th-text-primary)",
              }}
              value={draft.transport}
              onChange={(e) => setDraft((d) => ({ ...d, transport: e.target.value as "stdio" | "sse" }))}
            >
              <option value="stdio">stdio</option>
              <option value="sse">SSE / HTTP</option>
            </select>
          </div>

          {draft.transport === "stdio" ? (
            <div className="space-y-2">
              <div>
                <label className="block text-xs font-medium mb-1" style={{ color: "var(--th-text-secondary)" }}>
                  {t({ ko: "명령어", en: "Command", ja: "コマンド", zh: "Command", de: "Befehl" })}
                </label>
                <input
                  className="w-full rounded border px-2 py-1.5 text-sm font-mono"
                  style={{
                    borderColor: "var(--th-border)",
                    background: "var(--th-bg-primary)",
                    color: "var(--th-text-primary)",
                  }}
                  placeholder="npx"
                  value={draft.command ?? ""}
                  onChange={(e) => setDraft((d) => ({ ...d, command: e.target.value }))}
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1" style={{ color: "var(--th-text-secondary)" }}>
                  {t({
                    ko: "인수 (줄 단위)",
                    en: "Arguments (one per line)",
                    ja: "引数 (1行ずつ)",
                    zh: "Arguments (one per line)",
                    de: "Argumente (pro Zeile)",
                  })}
                </label>
                <textarea
                  className="w-full rounded border px-2 py-1.5 text-sm font-mono"
                  style={{
                    borderColor: "var(--th-border)",
                    background: "var(--th-bg-primary)",
                    color: "var(--th-text-primary)",
                  }}
                  rows={3}
                  placeholder={"-y\n@modelcontextprotocol/server-filesystem\n/home/user"}
                  value={argsText}
                  onChange={(e) => setArgsText(e.target.value)}
                />
              </div>
            </div>
          ) : (
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: "var(--th-text-secondary)" }}>
                URL
              </label>
              <input
                className="w-full rounded border px-2 py-1.5 text-sm font-mono"
                style={{
                  borderColor: "var(--th-border)",
                  background: "var(--th-bg-primary)",
                  color: "var(--th-text-primary)",
                }}
                placeholder="http://localhost:3001/sse"
                value={draft.url ?? ""}
                onChange={(e) => setDraft((d) => ({ ...d, url: e.target.value }))}
              />
            </div>
          )}

          {addError && (
            <div className="rounded px-2 py-1 text-xs" style={{ background: "rgba(239,68,68,0.1)", color: "#ef4444" }}>
              {addError}
            </div>
          )}

          <button
            onClick={handleAdd}
            disabled={saving || !draft.name.trim()}
            className="rounded-lg px-4 py-1.5 text-xs font-medium text-white transition-colors disabled:opacity-50"
            style={{ background: "var(--th-accent, #3b82f6)" }}
          >
            {saving
              ? t({ ko: "저장 중...", en: "Saving...", ja: "保存中...", zh: "Saving...", de: "Speichern..." })
              : t({ ko: "저장", en: "Save", ja: "保存", zh: "Save", de: "Speichern" })}
          </button>
        </div>
      )}

      {/* Action error banner */}
      {actionError && (
        <div className="rounded px-2 py-1 text-xs" style={{ background: "rgba(239,68,68,0.1)", color: "#ef4444" }}>
          {actionError}
        </div>
      )}

      {/* Server list */}
      {servers.length === 0 && !addMode && (
        <div className="rounded-lg border p-6 text-center" style={{ borderColor: "var(--th-border)" }}>
          <p className="text-sm" style={{ color: "var(--th-text-secondary)" }}>
            {t({
              ko: "구성된 MCP 서버가 없습니다",
              en: "No MCP servers configured",
              ja: "MCP サーバーが設定されていません",
              zh: "No MCP servers configured",
              de: "Keine MCP-Server konfiguriert",
            })}
          </p>
        </div>
      )}

      {servers.map((server) => (
        <div
          key={server.name}
          className="rounded-lg border p-3"
          style={{ borderColor: "var(--th-border)", background: "var(--th-bg-secondary)" }}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span
                className="inline-block h-2.5 w-2.5 rounded-full"
                style={{ background: server.connected ? "#22c55e" : "#ef4444" }}
              />
              <span className="text-sm font-medium" style={{ color: "var(--th-text-primary)" }}>
                {server.label || server.name}
              </span>
              <span className="text-xs font-mono" style={{ color: "var(--th-text-secondary)" }}>
                {server.transport}
              </span>
              {server.tools.length > 0 && (
                <span className="text-xs" style={{ color: "var(--th-text-secondary)" }}>
                  ({server.tools.length} tools)
                </span>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => handleTest(server.name)}
                disabled={testingServer === server.name}
                className="rounded px-2 py-1 text-xs transition-colors hover:opacity-80"
                style={{ color: "var(--th-text-secondary)" }}
              >
                {testingServer === server.name ? "..." : "Test"}
              </button>
              {server.connected ? (
                <button
                  onClick={() => handleDisconnect(server.name)}
                  className="rounded px-2 py-1 text-xs text-orange-400 transition-colors hover:opacity-80"
                >
                  {t({ ko: "연결 해제", en: "Disconnect", ja: "切断", zh: "Disconnect", de: "Trennen" })}
                </button>
              ) : (
                <button
                  onClick={() => handleConnect(server.name)}
                  className="rounded px-2 py-1 text-xs text-green-400 transition-colors hover:opacity-80"
                >
                  {t({ ko: "연결", en: "Connect", ja: "接続", zh: "Connect", de: "Verbinden" })}
                </button>
              )}
              <button
                onClick={() => setExpandedServer(expandedServer === server.name ? null : server.name)}
                className="rounded px-2 py-1 text-xs transition-colors hover:opacity-80"
                style={{ color: "var(--th-text-secondary)" }}
              >
                {expandedServer === server.name ? "▲" : "▼"}
              </button>
              <button
                onClick={() => handleDelete(server.name)}
                className="rounded px-2 py-1 text-xs text-red-400 transition-colors hover:opacity-80"
              >
                {t({ ko: "삭제", en: "Delete", ja: "削除", zh: "Delete", de: "Löschen" })}
              </button>
            </div>
          </div>

          {/* Test result */}
          {testResults[server.name] && (
            <div
              className="mt-2 rounded px-2 py-1 text-xs"
              style={{
                background: testResults[server.name].ok ? "rgba(34,197,94,0.1)" : "rgba(239,68,68,0.1)",
                color: testResults[server.name].ok ? "#22c55e" : "#ef4444",
              }}
            >
              {testResults[server.name].message}
            </div>
          )}

          {/* Error */}
          {server.error && (
            <div
              className="mt-2 rounded px-2 py-1 text-xs"
              style={{ background: "rgba(239,68,68,0.1)", color: "#ef4444" }}
            >
              {server.error}
            </div>
          )}

          {/* Expanded: tool list */}
          {expandedServer === server.name && server.tools.length > 0 && (
            <div className="mt-2 space-y-1">
              <div className="text-xs font-medium" style={{ color: "var(--th-text-secondary)" }}>
                {t({ ko: "도구", en: "Tools", ja: "ツール", zh: "Tools", de: "Tools" })}:
              </div>
              {server.tools.map((tool) => (
                <div key={tool.name} className="flex items-start gap-2 pl-2">
                  <span className="text-xs font-mono" style={{ color: "var(--th-text-primary)" }}>
                    {tool.name}
                  </span>
                  {tool.description && (
                    <span className="text-xs" style={{ color: "var(--th-text-secondary)" }}>
                      — {tool.description}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
