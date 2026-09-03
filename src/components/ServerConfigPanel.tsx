import { useEffect, useMemo, useState } from "react";
import { deleteServer, getServer, getServerTypePresets, runServerHealthCheck, updateServer } from "../api";
import { useI18n } from "../i18n";
import type { Agent, ServerAllocation, ServerNode, ServerTypePreset } from "../types";
import ServerFileBrowser from "./ServerFileBrowser";

type AuthMode = "none" | "bearer" | "api_key" | "header";

interface ServerConfigPanelProps {
  server: ServerNode | null;
  servers?: ServerNode[];
  agents: Agent[];
  initialAllocations?: ServerAllocation[];
  onClose: () => void;
  onUpdated: () => void;
}

function parseAuthConfig(raw: string | null | undefined): {
  mode: AuthMode;
  token: string;
  key: string;
  header: string;
  value: string;
} {
  if (!raw) return { mode: "none", token: "", key: "", header: "x-api-key", value: "" };
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const mode = String(parsed.mode ?? "none")
      .trim()
      .toLowerCase() as AuthMode;
    return {
      mode: mode === "bearer" || mode === "api_key" || mode === "header" ? mode : "none",
      token: String(parsed.token ?? ""),
      key: String(parsed.key ?? ""),
      header: String(parsed.header ?? "x-api-key"),
      value: String(parsed.value ?? ""),
    };
  } catch {
    return { mode: "none", token: "", key: "", header: "x-api-key", value: "" };
  }
}

function buildAuthConfig(
  mode: AuthMode,
  input: { token: string; key: string; header: string; value: string },
): string | null {
  if (mode === "none") return null;
  if (mode === "bearer") return JSON.stringify({ mode, token: input.token.trim() });
  if (mode === "api_key")
    return JSON.stringify({ mode, key: input.key.trim(), header: input.header.trim() || "x-api-key" });
  return JSON.stringify({ mode, header: input.header.trim(), value: input.value.trim() });
}

export default function ServerConfigPanel({
  server,
  servers,
  agents,
  initialAllocations = [],
  onClose,
  onUpdated,
}: ServerConfigPanelProps) {
  const { t } = useI18n();
  const [detail, setDetail] = useState<ServerNode | null>(server);
  const [allocations, setAllocations] = useState<ServerAllocation[]>(initialAllocations);
  const [presets, setPresets] = useState<ServerTypePreset[]>([]);
  const [endpoint, setEndpoint] = useState(server?.endpoint_url ?? "");
  const [maxConcurrentJobs, setMaxConcurrentJobs] = useState(Math.max(1, Number(server?.max_concurrent_jobs ?? 1)));
  const [enabled, setEnabled] = useState(Number(server?.enabled ?? 1) === 1);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [authMode, setAuthMode] = useState<AuthMode>("none");
  const [authToken, setAuthToken] = useState("");
  const [authKey, setAuthKey] = useState("");
  const [authHeader, setAuthHeader] = useState("x-api-key");
  const [authValue, setAuthValue] = useState("");

  // SSH config state
  const [sshEnabled, setSshEnabled] = useState(false);
  const [sshHost, setSshHost] = useState("");
  const [sshPort, setSshPort] = useState(22);
  const [sshUser, setSshUser] = useState("");
  const [sshKeyPath, setSshKeyPath] = useState("");
  const [sshKnownHostsPolicy, setSshKnownHostsPolicy] = useState<"accept" | "strict">("accept");
  const [sshTestResult, setSshTestResult] = useState<{ success: boolean; error?: string } | null>(null);
  const [sshTesting, setSshTesting] = useState(false);
  const [showFileBrowser, setShowFileBrowser] = useState(false);

  const allServers = servers ?? (server ? [server] : []);
  const [activeServerId, setActiveServerId] = useState<string | null>(server?.id ?? allServers[0]?.id ?? null);
  const activeServer = allServers.find((s) => s.id === activeServerId) ?? null;

  // Reset form fields and invalidate detail when switching servers
  useEffect(() => {
    // Immediately clear detail so action buttons are disabled until fresh data loads
    setDetail(null);
    setAllocations([]);

    if (!activeServer) return;
    setEndpoint(activeServer.endpoint_url ?? "");
    setMaxConcurrentJobs(Math.max(1, Number(activeServer.max_concurrent_jobs ?? 1)));
    setEnabled(Number(activeServer.enabled ?? 1) === 1);
    const auth = parseAuthConfig(activeServer.auth_config_json);
    setAuthMode(auth.mode);
    setAuthToken(auth.token);
    setAuthKey(auth.key);
    setAuthHeader(auth.header || "x-api-key");
    setAuthValue(auth.value);
    if (activeServer.ssh_config_json) {
      try {
        const parsed = JSON.parse(activeServer.ssh_config_json) as Record<string, unknown>;
        setSshEnabled(true);
        setSshHost(String(parsed.host ?? ""));
        setSshPort(Number(parsed.port) || 22);
        setSshUser(String(parsed.user ?? ""));
        setSshKeyPath(String(parsed.private_key_path ?? ""));
        setSshKnownHostsPolicy(parsed.known_hosts_policy === "strict" ? "strict" : "accept");
      } catch {
        setSshEnabled(false);
      }
    } else {
      setSshEnabled(activeServer.type === "ssh_remote");
      setSshHost("");
      setSshPort(22);
      setSshUser("");
      setSshKeyPath("");
      setSshKnownHostsPolicy("accept");
    }
    setSshTestResult(null);
    setShowFileBrowser(false);

    // Fetch fresh detail for the newly selected server
    let stale = false;
    getServer(activeServer.id)
      .then((payload) => {
        if (!stale) {
          setDetail(payload.server);
          setAllocations(payload.allocations);
        }
      })
      .catch(() => {});
    getServerTypePresets()
      .then(setPresets)
      .catch(() => setPresets([]));
    return () => {
      stale = true;
    };
  }, [activeServerId]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadDetail = async () => {
    if (!activeServerId) return;
    const payload = await getServer(activeServerId);
    setDetail(payload.server);
    setAllocations(payload.allocations);
  };

  const preset = useMemo(() => presets.find((entry) => entry.type === detail?.type) ?? null, [detail?.type, presets]);
  const activeAllocations = useMemo(() => allocations.filter((entry) => entry.status === "active"), [allocations]);
  const queuedAllocations = useMemo(() => allocations.filter((entry) => entry.status === "queued"), [allocations]);

  const handleSave = async () => {
    if (!detail) return;
    setSaving(true);
    try {
      await updateServer(detail.id, {
        endpoint_url: endpoint.trim() || null,
        max_concurrent_jobs: Math.max(1, Number(maxConcurrentJobs || 1)),
        enabled: enabled ? 1 : 0,
        auth_config_json: buildAuthConfig(authMode, {
          token: authToken,
          key: authKey,
          header: authHeader,
          value: authValue,
        }),
        ssh_config_json: sshEnabled
          ? JSON.stringify({
              host: sshHost.trim(),
              port: sshPort,
              user: sshUser.trim(),
              private_key_path: sshKeyPath.trim(),
              known_hosts_policy: sshKnownHostsPolicy,
            })
          : null,
      });
      await loadDetail();
      onUpdated();
    } catch (error) {
      console.error("Server update failed:", error);
    } finally {
      setSaving(false);
    }
  };

  const handleHealthCheck = async () => {
    if (!detail) return;
    try {
      await runServerHealthCheck(detail.id);
      await loadDetail();
      onUpdated();
    } catch (error) {
      console.error("Server health check failed:", error);
    }
  };

  const handleDelete = async () => {
    if (!detail) return;
    if (
      !window.confirm(
        t({
          ko: "이 서버를 삭제할까요?",
          en: "Delete this server?",
          ja: "このサーバーを削除しますか？",
          zh: "Delete this server?",
        }),
      )
    )
      return;
    setDeleting(true);
    try {
      await deleteServer(detail.id);
      onUpdated();
      onClose();
    } catch (error) {
      console.error("Server delete failed:", error);
    } finally {
      setDeleting(false);
    }
  };

  const handleSshTest = async () => {
    if (!detail) return;
    setSshTesting(true);
    setSshTestResult(null);
    try {
      const { testSshConnection } = await import("../api/server-ssh");
      const result = await testSshConnection(detail.id);
      setSshTestResult(result);
    } catch (err) {
      setSshTestResult({ success: false, error: String(err) });
    } finally {
      setSshTesting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div
        className="w-[calc(100vw-1.5rem)] max-w-[560px] max-h-[88vh] overflow-auto border shadow-[var(--shadow-modal)]"
        style={{
          background: "var(--th-bg-secondary)",
          borderColor: "var(--th-border)",
          borderRadius: "var(--radius-lg)",
        }}
      >
        <div
          className="sticky top-0 z-10 border-b px-5 py-4"
          style={{ borderColor: "var(--th-border)", background: "var(--th-bg-secondary)" }}
        >
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="text-sm font-semibold" style={{ color: "var(--th-text-heading)" }}>
                {detail?.name ?? activeServer?.name ?? "Server Room"}
              </h2>
              <p className="text-xs" style={{ color: "var(--th-text-secondary)" }}>
                {detail
                  ? `${detail.type} · ${detail.status} · ${detail.current_jobs}/${detail.max_concurrent_jobs}`
                  : activeServer
                    ? `${activeServer.type} · ${activeServer.status}`
                    : `${allServers.length} servers`}
              </p>
            </div>
            <button
              onClick={onClose}
              className="rounded-lg border px-2 py-1 text-xs"
              style={{ borderColor: "var(--th-border)", color: "var(--th-text-secondary)" }}
            >
              CLOSE
            </button>
          </div>
        </div>

        {allServers.length > 1 && (
          <div
            className="flex gap-1.5 overflow-x-auto border-b px-5 py-2 no-scrollbar"
            style={{ borderColor: "var(--th-border)" }}
          >
            {allServers.map((s) => (
              <button
                key={s.id}
                onClick={() => setActiveServerId(s.id)}
                className={`flex-shrink-0 rounded-lg border px-3 py-1.5 text-xs font-medium transition ${s.id === activeServerId ? "border-blue-500 text-blue-400" : ""}`}
                style={
                  s.id === activeServerId
                    ? undefined
                    : { borderColor: "var(--th-border)", color: "var(--th-text-secondary)" }
                }
              >
                <span
                  className="mr-1.5 inline-block h-2 w-2 rounded-full"
                  style={{
                    background:
                      s.status === "online" || s.status === "busy"
                        ? "#4ade80"
                        : s.status === "idle"
                          ? "#22d3ee"
                          : "#64748b",
                  }}
                />
                {s.name}
              </button>
            ))}
          </div>
        )}

        {!activeServer ? (
          <div className="px-5 py-8 text-center text-sm" style={{ color: "var(--th-text-muted)" }}>
            No servers configured
          </div>
        ) : (
          <div className="space-y-4 px-5 py-4 text-sm">
            <label className="block">
              <div className="mb-1 text-xs" style={{ color: "var(--th-text-secondary)" }}>
                Endpoint URL
              </div>
              <input
                value={endpoint}
                onChange={(event) => setEndpoint(event.target.value)}
                className="w-full rounded-lg border px-3 py-2"
                style={{
                  background: "var(--th-input-bg)",
                  borderColor: "var(--th-input-border)",
                  color: "var(--th-text-primary)",
                }}
                placeholder="https://..."
              />
            </label>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="block">
                <div className="mb-1 text-xs" style={{ color: "var(--th-text-secondary)" }}>
                  Max Concurrent Jobs
                </div>
                <input
                  type="number"
                  min={1}
                  value={maxConcurrentJobs}
                  onChange={(event) => setMaxConcurrentJobs(Math.max(1, Number(event.target.value || 1)))}
                  className="w-full rounded-lg border px-3 py-2"
                  style={{
                    background: "var(--th-input-bg)",
                    borderColor: "var(--th-input-border)",
                    color: "var(--th-text-primary)",
                  }}
                />
              </label>
              <label className="flex items-center gap-2 pt-6 text-xs" style={{ color: "var(--th-text-secondary)" }}>
                <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
                Enabled
              </label>
            </div>

            <div
              className="rounded-lg border p-3"
              style={{ borderColor: "var(--th-border)", background: "var(--th-input-bg)" }}
            >
              <div className="mb-2 text-xs" style={{ color: "var(--th-text-secondary)" }}>
                Auth Credentials
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <select
                  value={authMode}
                  onChange={(event) => setAuthMode(event.target.value as AuthMode)}
                  className="rounded-lg border px-3 py-2 text-xs"
                  style={{
                    background: "var(--th-input-bg)",
                    borderColor: "var(--th-input-border)",
                    color: "var(--th-text-primary)",
                  }}
                >
                  <option value="none">None</option>
                  <option value="bearer">Bearer Token</option>
                  <option value="api_key">API Key Header</option>
                  <option value="header">Custom Header</option>
                </select>
                {authMode === "bearer" && (
                  <input
                    value={authToken}
                    onChange={(event) => setAuthToken(event.target.value)}
                    className="rounded-lg border px-3 py-2 text-xs"
                    style={{
                      background: "var(--th-input-bg)",
                      borderColor: "var(--th-input-border)",
                      color: "var(--th-text-primary)",
                    }}
                    placeholder="Bearer token"
                  />
                )}
                {authMode === "api_key" && (
                  <>
                    <input
                      value={authHeader}
                      onChange={(event) => setAuthHeader(event.target.value)}
                      className="rounded-lg border px-3 py-2 text-xs"
                      style={{
                        background: "var(--th-input-bg)",
                        borderColor: "var(--th-input-border)",
                        color: "var(--th-text-primary)",
                      }}
                      placeholder="x-api-key"
                    />
                    <input
                      value={authKey}
                      onChange={(event) => setAuthKey(event.target.value)}
                      className="rounded-lg border px-3 py-2 text-xs"
                      style={{
                        background: "var(--th-input-bg)",
                        borderColor: "var(--th-input-border)",
                        color: "var(--th-text-primary)",
                      }}
                      placeholder="API key"
                    />
                  </>
                )}
                {authMode === "header" && (
                  <>
                    <input
                      value={authHeader}
                      onChange={(event) => setAuthHeader(event.target.value)}
                      className="rounded-lg border px-3 py-2 text-xs"
                      style={{
                        background: "var(--th-input-bg)",
                        borderColor: "var(--th-input-border)",
                        color: "var(--th-text-primary)",
                      }}
                      placeholder="Header name"
                    />
                    <input
                      value={authValue}
                      onChange={(event) => setAuthValue(event.target.value)}
                      className="rounded-lg border px-3 py-2 text-xs"
                      style={{
                        background: "var(--th-input-bg)",
                        borderColor: "var(--th-input-border)",
                        color: "var(--th-text-primary)",
                      }}
                      placeholder="Header value"
                    />
                  </>
                )}
              </div>
            </div>

            {/* SSH Configuration */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium" style={{ color: "var(--th-text-heading)" }}>
                  SSH Configuration
                </span>
                {detail?.type !== "ssh_remote" && (
                  <label
                    className="flex items-center gap-1.5 text-xs cursor-pointer"
                    style={{ color: "var(--th-text-secondary)" }}
                  >
                    <input
                      type="checkbox"
                      checked={sshEnabled}
                      onChange={(e) => setSshEnabled(e.target.checked)}
                      className="accent-current"
                    />
                    Enable
                  </label>
                )}
              </div>
              {sshEnabled && (
                <div className="space-y-2 rounded-lg border p-3" style={{ borderColor: "var(--th-border)" }}>
                  <label className="block">
                    <span className="text-[11px]" style={{ color: "var(--th-text-secondary)" }}>
                      Host (Tailscale IP / Hostname)
                    </span>
                    <input
                      className="mt-0.5 w-full rounded-lg border px-2 py-1 text-xs"
                      style={{
                        background: "var(--th-bg-primary)",
                        borderColor: "var(--th-border)",
                        color: "var(--th-text-primary)",
                      }}
                      value={sshHost}
                      onChange={(e) => setSshHost(e.target.value)}
                      placeholder="100.101.102.103"
                    />
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="block">
                      <span className="text-[11px]" style={{ color: "var(--th-text-secondary)" }}>
                        User
                      </span>
                      <input
                        className="mt-0.5 w-full rounded-lg border px-2 py-1 text-xs"
                        style={{
                          background: "var(--th-bg-primary)",
                          borderColor: "var(--th-border)",
                          color: "var(--th-text-primary)",
                        }}
                        value={sshUser}
                        onChange={(e) => setSshUser(e.target.value)}
                        placeholder="user"
                      />
                    </label>
                    <label className="block">
                      <span className="text-[11px]" style={{ color: "var(--th-text-secondary)" }}>
                        Port
                      </span>
                      <input
                        type="number"
                        className="mt-0.5 w-full rounded-lg border px-2 py-1 text-xs"
                        style={{
                          background: "var(--th-bg-primary)",
                          borderColor: "var(--th-border)",
                          color: "var(--th-text-primary)",
                        }}
                        value={sshPort}
                        onChange={(e) => setSshPort(Number(e.target.value) || 22)}
                      />
                    </label>
                  </div>
                  <label className="block">
                    <span className="text-[11px]" style={{ color: "var(--th-text-secondary)" }}>
                      Private Key Path
                    </span>
                    <input
                      className="mt-0.5 w-full rounded-lg border px-2 py-1 text-xs"
                      style={{
                        background: "var(--th-bg-primary)",
                        borderColor: "var(--th-border)",
                        color: "var(--th-text-primary)",
                      }}
                      value={sshKeyPath}
                      onChange={(e) => setSshKeyPath(e.target.value)}
                      placeholder="/home/user/.ssh/id_ed25519"
                    />
                  </label>
                  <label className="block">
                    <span className="text-[11px]" style={{ color: "var(--th-text-secondary)" }}>
                      Host Key Verification
                    </span>
                    <select
                      className="mt-0.5 w-full rounded-lg border px-2 py-1 text-xs"
                      style={{
                        background: "var(--th-bg-primary)",
                        borderColor: "var(--th-border)",
                        color: "var(--th-text-primary)",
                      }}
                      value={sshKnownHostsPolicy}
                      onChange={(e) => setSshKnownHostsPolicy(e.target.value as "accept" | "strict")}
                    >
                      <option value="accept">Accept unknown hosts</option>
                      <option value="strict">Strict host checking</option>
                    </select>
                  </label>
                  <div className="flex items-center gap-2 pt-1">
                    <button
                      className="rounded-lg border px-3 py-1 text-xs"
                      style={{ borderColor: "var(--th-border)", color: "var(--th-text-primary)" }}
                      onClick={handleSshTest}
                      disabled={sshTesting || !sshHost.trim() || !sshUser.trim()}
                    >
                      {sshTesting ? "Testing..." : "Test Connection"}
                    </button>
                    {sshTestResult && (
                      <span
                        className="text-xs"
                        style={{
                          color: sshTestResult.success ? "var(--th-success, #22c55e)" : "var(--th-error, #ef4444)",
                        }}
                      >
                        {sshTestResult.success ? "Connected" : (sshTestResult.error ?? "Failed")}
                      </span>
                    )}
                    <button
                      className="ml-auto rounded-lg border px-3 py-1 text-xs"
                      style={{ borderColor: "var(--th-border)", color: "var(--th-text-secondary)" }}
                      onClick={() => setShowFileBrowser((v) => !v)}
                    >
                      {showFileBrowser ? "Hide File System" : "File System"}
                    </button>
                  </div>
                </div>
              )}
              {sshEnabled && showFileBrowser && detail && <ServerFileBrowser serverId={detail.id} initialPath="~" />}
            </div>

            {preset && (
              <div
                className="rounded-lg border p-3 text-xs"
                style={{
                  borderColor: "var(--th-border)",
                  background: "var(--th-input-bg)",
                  color: "var(--th-text-secondary)",
                }}
              >
                <div className="font-semibold" style={{ color: "var(--th-text-primary)" }}>
                  {preset.label}
                </div>
                <div>{preset.description}</div>
                <div className="mt-1">{preset.examples.join(" · ")}</div>
              </div>
            )}

            <div
              className="rounded-lg border p-3"
              style={{ borderColor: "var(--th-border)", background: "var(--th-input-bg)" }}
            >
              <div className="mb-1 text-xs" style={{ color: "var(--th-text-secondary)" }}>
                Active Agent Bindings ({activeAllocations.length})
              </div>
              {activeAllocations.length === 0 && (
                <div className="text-xs" style={{ color: "var(--th-text-muted)" }}>
                  No active allocation
                </div>
              )}
              {activeAllocations.map((allocation) => {
                const agent =
                  agents.find((entry) => entry.id === allocation.agent_id) ??
                  (allocation.agent_id ? ({ name: allocation.agent_id } as Agent) : null);
                return (
                  <div key={allocation.id} className="text-xs" style={{ color: "var(--th-text-secondary)" }}>
                    {allocation.agent_name || agent?.name || "Unknown Agent"} ·{" "}
                    {allocation.task_title || allocation.task_id || "-"}
                  </div>
                );
              })}
              <div className="mt-2 mb-1 text-xs" style={{ color: "var(--th-text-secondary)" }}>
                Queue ({queuedAllocations.length})
              </div>
              {queuedAllocations.length === 0 && (
                <div className="text-xs" style={{ color: "var(--th-text-muted)" }}>
                  Queue empty
                </div>
              )}
              {queuedAllocations.map((allocation) => (
                <div key={allocation.id} className="text-xs" style={{ color: "var(--th-text-secondary)" }}>
                  {allocation.agent_name || allocation.agent_id || "Unknown Agent"} ·{" "}
                  {allocation.task_title || allocation.task_id || "-"}
                </div>
              ))}
            </div>

            <div className="flex flex-wrap gap-2 pb-1">
              <button
                onClick={handleSave}
                disabled={saving || !detail}
                className="rounded-lg border border-emerald-700 bg-emerald-900/30 px-3 py-2 text-xs text-emerald-200 disabled:opacity-50"
              >
                {saving ? "Saving..." : "Save"}
              </button>
              <button
                onClick={handleHealthCheck}
                disabled={!detail}
                className="rounded-lg border border-sky-700 bg-sky-900/30 px-3 py-2 text-xs text-sky-200 disabled:opacity-50"
              >
                Health Check
              </button>
              <button
                onClick={() => {
                  void loadDetail();
                }}
                className="rounded-lg border px-3 py-2 text-xs"
                style={{ borderColor: "var(--th-border)", color: "var(--th-text-secondary)" }}
              >
                Refresh
              </button>
              <button
                onClick={handleDelete}
                disabled={deleting || !detail}
                className="rounded-lg border border-red-700 bg-red-900/30 px-3 py-2 text-xs text-red-200 disabled:opacity-50"
              >
                {deleting ? "Deleting..." : "Delete"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
