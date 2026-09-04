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
  type McpConfigValue,
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

/**
 * One credential row in the form.
 *
 * `mode` decides what is stored: a literal string, or a pointer into a vault
 * (see server/connectors/built-in/mcp/mcp-secrets.ts). A server configured
 * with pointers can only be started by the runner — that is not a limitation
 * to hide, it is the reason the option exists, so the form says so.
 */
interface CredentialRow {
  key: string;
  mode: "literal" | "secret";
  value: string;
  provider: "vaultwarden" | "protonpass" | "keychain";
  itemRef: string;
  field: string;
}

const EMPTY_CREDENTIAL: CredentialRow = {
  key: "",
  mode: "secret",
  value: "",
  provider: "vaultwarden",
  itemRef: "",
  field: "",
};

/** Rows → the map the API expects. Rows without a key are simply not there. */
export function credentialsToMap(rows: CredentialRow[]): Record<string, McpConfigValue> | undefined {
  const map: Record<string, McpConfigValue> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (!key) continue;
    map[key] =
      row.mode === "literal"
        ? row.value
        : {
            $secret: {
              provider: row.provider,
              itemRef: row.itemRef.trim(),
              ...(row.field.trim() ? { field: row.field.trim() } : {}),
            },
          };
  }
  return Object.keys(map).length > 0 ? map : undefined;
}

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
  const [credentials, setCredentials] = useState<CredentialRow[]>([]);
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
      const map = credentialsToMap(credentials);
      const config: McpServerConfig = {
        ...draft,
        args: argsText
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean),
        // stdio servers take an environment, HTTP ones take headers — the
        // same rows, put where that transport reads them.
        ...(draft.transport === "stdio" ? { env: map } : { headers: map }),
      };
      const res = await addMcpServer(config);
      if (res.ok === false) throw new Error(res.error ?? "Speichern fehlgeschlagen");
      setAddMode(false);
      setDraft({ ...EMPTY_CONFIG });
      setArgsText("");
      setCredentials([]);
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
              onChange={(e) => setDraft((d) => ({ ...d, transport: e.target.value as McpServerConfig["transport"] }))}
            >
              <option value="stdio">stdio</option>
              <option value="http">HTTP (streamable)</option>
              <option value="sse">SSE (älter)</option>
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

          {/* Credentials — literal, or a pointer into a vault */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="block text-xs font-medium" style={{ color: "var(--th-text-secondary)" }}>
                {draft.transport === "stdio"
                  ? t({
                      ko: "환경 변수",
                      en: "Environment variables",
                      ja: "環境変数",
                      zh: "Environment variables",
                      de: "Umgebungsvariablen",
                    })
                  : t({ ko: "헤더", en: "Headers", ja: "ヘッダー", zh: "Headers", de: "Header" })}
              </label>
              <button
                onClick={() => setCredentials((rows) => [...rows, { ...EMPTY_CREDENTIAL }])}
                className="rounded px-2 py-0.5 text-xs transition-colors hover:opacity-80"
                style={{ color: "var(--th-text-secondary)" }}
              >
                +
              </button>
            </div>

            {credentials.map((row, index) => {
              const update = (patch: Partial<CredentialRow>) =>
                setCredentials((rows) => rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));
              return (
                <div key={index} className="flex flex-wrap items-center gap-1.5">
                  <input
                    className="rounded border px-2 py-1 text-xs font-mono"
                    style={{
                      borderColor: "var(--th-border)",
                      background: "var(--th-bg-primary)",
                      color: "var(--th-text-primary)",
                      width: "10rem",
                    }}
                    placeholder={draft.transport === "stdio" ? "GITHUB_TOKEN" : "Authorization"}
                    value={row.key}
                    onChange={(e) => update({ key: e.target.value })}
                  />
                  <select
                    className="rounded border px-2 py-1 text-xs"
                    style={{
                      borderColor: "var(--th-border)",
                      background: "var(--th-bg-primary)",
                      color: "var(--th-text-primary)",
                    }}
                    value={row.mode}
                    onChange={(e) => update({ mode: e.target.value as CredentialRow["mode"] })}
                  >
                    <option value="secret">
                      {t({ ko: "금고", en: "Vault", ja: "金庫", zh: "Vault", de: "Tresor" })}
                    </option>
                    <option value="literal">{t({ ko: "값", en: "Value", ja: "値", zh: "Value", de: "Wert" })}</option>
                  </select>

                  {row.mode === "literal" ? (
                    <input
                      className="flex-1 rounded border px-2 py-1 text-xs font-mono"
                      style={{
                        borderColor: "var(--th-border)",
                        background: "var(--th-bg-primary)",
                        color: "var(--th-text-primary)",
                      }}
                      placeholder="production"
                      value={row.value}
                      onChange={(e) => update({ value: e.target.value })}
                    />
                  ) : (
                    <>
                      <select
                        className="rounded border px-2 py-1 text-xs"
                        style={{
                          borderColor: "var(--th-border)",
                          background: "var(--th-bg-primary)",
                          color: "var(--th-text-primary)",
                        }}
                        value={row.provider}
                        onChange={(e) => update({ provider: e.target.value as CredentialRow["provider"] })}
                      >
                        <option value="vaultwarden">Vaultwarden</option>
                        <option value="protonpass">Proton Pass</option>
                        <option value="keychain">Keychain</option>
                      </select>
                      <input
                        className="flex-1 rounded border px-2 py-1 text-xs font-mono"
                        style={{
                          borderColor: "var(--th-border)",
                          background: "var(--th-bg-primary)",
                          color: "var(--th-text-primary)",
                          minWidth: "8rem",
                        }}
                        placeholder={t({
                          ko: "항목",
                          en: "Item",
                          ja: "アイテム",
                          zh: "Item",
                          de: "Eintrag im Tresor",
                        })}
                        value={row.itemRef}
                        onChange={(e) => update({ itemRef: e.target.value })}
                      />
                      <input
                        className="rounded border px-2 py-1 text-xs font-mono"
                        style={{
                          borderColor: "var(--th-border)",
                          background: "var(--th-bg-primary)",
                          color: "var(--th-text-primary)",
                          width: "7rem",
                        }}
                        placeholder="password"
                        value={row.field}
                        onChange={(e) => update({ field: e.target.value })}
                      />
                    </>
                  )}

                  <button
                    onClick={() => setCredentials((rows) => rows.filter((_, i) => i !== index))}
                    className="rounded px-1.5 py-1 text-xs text-red-400 transition-colors hover:opacity-80"
                  >
                    ×
                  </button>
                </div>
              );
            })}

            {credentials.some((row) => row.mode === "secret") && (
              <p className="text-xs" style={{ color: "var(--th-text-secondary)" }}>
                {t({
                  ko: "금고 참조를 사용하는 서버는 러너에서 시작됩니다.",
                  en: "A server that references the vault is started by the runner — the control plane never sees the value.",
                  ja: "金庫を参照するサーバーはランナーで起動します。",
                  zh: "A server that references the vault is started by the runner.",
                  de: "Ein Server mit Tresor-Verweis wird vom Runner gestartet — die Steuerebene sieht den Wert nie.",
                })}
              </p>
            )}
          </div>

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
              {server.needsRunner && (
                <span
                  className="rounded px-1.5 py-0.5 text-xs"
                  style={{ background: "rgba(59,130,246,0.12)", color: "var(--th-accent, #3b82f6)" }}
                  title={t({
                    ko: "이 서버는 러너에서 실행됩니다",
                    en: "Credentials come from the vault, so this server runs on the runner",
                    ja: "このサーバーはランナーで動作します",
                    zh: "This server runs on the runner",
                    de: "Zugangsdaten kommen aus dem Tresor — dieser Server läuft auf dem Runner",
                  })}
                >
                  Runner
                </span>
              )}
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
