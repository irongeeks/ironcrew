import { useCallback, useEffect, useState } from "react";
import { createServer, getServer, getServers } from "../../api";
import type { Agent, ServerAllocation, ServerNode, ServerType } from "../../types";
import type { TFunction } from "./types";
import ServerConfigPanel from "../ServerConfigPanel";

interface Props {
  t: TFunction;
  agents: Agent[];
}

export default function ServersSettingsTab({ t, agents }: Props) {
  const [servers, setServers] = useState<ServerNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedServer, setSelectedServer] = useState<ServerNode | null>(null);
  const [allocations, setAllocations] = useState<ServerAllocation[]>([]);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState<ServerType>("ssh_remote");

  const loadServers = useCallback(async () => {
    try {
      const list = await getServers();
      setServers(list);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadServers();
  }, [loadServers]);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const server = await createServer({ name: newName.trim(), type: newType });
      setNewName("");
      await loadServers();
      setSelectedServer(server);
    } catch (err) {
      console.error("Failed to create server:", err);
    } finally {
      setCreating(false);
    }
  };

  const handleSelectServer = async (server: ServerNode) => {
    try {
      const detail = await getServer(server.id);
      setAllocations(detail.allocations);
    } catch {
      setAllocations([]);
    }
    setSelectedServer(server);
  };

  const statusColor = (status: string) => {
    switch (status) {
      case "online":
      case "idle":
        return "var(--th-success, #22c55e)";
      case "busy":
        return "var(--th-warning, #f59e0b)";
      default:
        return "var(--th-text-secondary)";
    }
  };

  const typeLabel = (type: string) => {
    switch (type) {
      case "ssh_remote":
        return "SSH Remote";
      case "comfyui":
        return "ComfyUI";
      case "llm_api":
        return "LLM API";
      case "database":
        return "Database";
      case "file_storage":
        return "File Storage";
      default:
        return type;
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-xs" style={{ color: "var(--th-text-secondary)" }}>
        {t({
          ko: "서버를 추가하고 SSH 연결, 상태, 할당을 관리합니다.",
          en: "Add servers and manage SSH connections, health, and allocations.",
          ja: "サーバーを追加し、SSH接続、ステータス、割り当てを管理します。",
          zh: "Add servers and manage SSH connections, health, and allocations.",
          de: "Server hinzufügen und SSH-Verbindungen, Status und Zuweisungen verwalten.",
        })}
      </p>

      {/* Add Server */}
      <div
        className="flex items-end gap-2 rounded-lg border p-3"
        style={{ borderColor: "var(--th-border)", background: "var(--th-bg-primary)" }}
      >
        <label className="flex-1">
          <span className="text-[11px]" style={{ color: "var(--th-text-secondary)" }}>
            {t({ ko: "서버 이름", en: "Server Name", ja: "サーバー名", zh: "Server Name", de: "Servername" })}
          </span>
          <input
            className="mt-0.5 w-full rounded border px-2 py-1.5 text-xs"
            style={{
              background: "var(--th-bg-secondary)",
              borderColor: "var(--th-border)",
              color: "var(--th-text-primary)",
            }}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="my-server"
            onKeyDown={(e) => e.key === "Enter" && handleCreate()}
          />
        </label>
        <label>
          <span className="text-[11px]" style={{ color: "var(--th-text-secondary)" }}>
            {t({ ko: "유형", en: "Type", ja: "種別", zh: "Type", de: "Typ" })}
          </span>
          <select
            className="mt-0.5 w-full rounded border px-2 py-1.5 text-xs"
            style={{
              background: "var(--th-bg-secondary)",
              borderColor: "var(--th-border)",
              color: "var(--th-text-primary)",
            }}
            value={newType}
            onChange={(e) => setNewType(e.target.value as ServerType)}
          >
            <option value="ssh_remote">SSH Remote</option>
            <option value="comfyui">ComfyUI</option>
            <option value="llm_api">LLM API</option>
            <option value="database">Database</option>
            <option value="file_storage">File Storage</option>
          </select>
        </label>
        <button
          onClick={handleCreate}
          disabled={creating || !newName.trim()}
          className="rounded px-4 py-1.5 text-xs font-medium transition-colors disabled:opacity-50"
          style={{ background: "var(--th-accent)", color: "#fff" }}
        >
          {creating
            ? t({ ko: "추가 중...", en: "Adding...", ja: "追加中...", zh: "Adding...", de: "Wird hinzugefügt..." })
            : t({ ko: "추가", en: "Add", ja: "追加", zh: "Add", de: "Hinzufügen" })}
        </button>
      </div>

      {/* Server List */}
      {loading ? (
        <p className="text-xs" style={{ color: "var(--th-text-secondary)" }}>
          {t({ ko: "로딩...", en: "Loading...", ja: "読み込み中...", zh: "Loading...", de: "Laden..." })}
        </p>
      ) : servers.length === 0 ? (
        <p className="text-xs py-6 text-center" style={{ color: "var(--th-text-secondary)" }}>
          {t({
            ko: "등록된 서버가 없습니다.",
            en: "No servers registered yet.",
            ja: "サーバーが登録されていません。",
            zh: "No servers registered yet.",
            de: "Noch keine Server registriert.",
          })}
        </p>
      ) : (
        <div className="space-y-1.5">
          {servers.map((s) => (
            <button
              key={s.id}
              onClick={() => handleSelectServer(s)}
              className="flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors hover:opacity-80"
              style={{ borderColor: "var(--th-border)", background: "var(--th-bg-primary)" }}
            >
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ background: statusColor(s.status) }}
                title={s.status}
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium" style={{ color: "var(--th-text-heading)" }}>
                  {s.name}
                </div>
                <div className="text-[11px]" style={{ color: "var(--th-text-secondary)" }}>
                  {typeLabel(s.type)}
                  {s.endpoint_url ? ` · ${s.endpoint_url}` : ""}
                  {s.ssh_config_json ? " · SSH" : ""}
                </div>
              </div>
              <div className="text-[11px] shrink-0" style={{ color: "var(--th-text-secondary)" }}>
                {s.current_jobs}/{s.max_concurrent_jobs}
              </div>
            </button>
          ))}
        </div>
      )}

      {/* Server Config Panel */}
      {selectedServer && (
        <ServerConfigPanel
          server={servers.find((s) => s.id === selectedServer.id) ?? selectedServer}
          agents={agents}
          initialAllocations={allocations}
          onClose={() => setSelectedServer(null)}
          onUpdated={() => {
            void loadServers();
          }}
        />
      )}
    </div>
  );
}
