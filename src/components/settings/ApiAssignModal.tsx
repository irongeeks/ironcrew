import type { LangText } from "../../i18n";
import AgentAvatar, { buildSpriteMap } from "../AgentAvatar";
import type { Agent } from "../../types";
import type { ApiStateBundle, TFunction } from "./types";

interface ApiAssignModalProps {
  t: TFunction;
  localeTag: string;
  apiState: ApiStateBundle;
}

export default function ApiAssignModal({ t, localeTag, apiState }: ApiAssignModalProps) {
  const { apiAssignTarget, apiAssigning, apiAssignAgents, apiAssignDepts, setApiAssignTarget, handleApiAssignToAgent } =
    apiState;

  if (!apiAssignTarget) return null;

  const spriteMap = buildSpriteMap(apiAssignAgents);
  const localName = (nameEn: string, nameKo: string) => (localeTag === "ko" ? nameKo || nameEn : nameEn || nameKo);
  const ROLE_LABELS: Record<string, Record<string, string>> = {
    team_leader: { ko: "팀장", en: "Team Leader", ja: "チームリーダー", zh: "Team Leader", de: "Teamleiter" },
    senior: { ko: "시니어", en: "Senior", ja: "シニア", zh: "Senior", de: "Senior" },
    junior: { ko: "주니어", en: "Junior", ja: "ジュニア", zh: "Junior", de: "Junior" },
    intern: { ko: "인턴", en: "Intern", ja: "インターン", zh: "Intern", de: "Praktikant" },
  };

  const roleBadge = (role: string) => {
    const label = ROLE_LABELS[role];
    const text = label ? t(label as LangText) : role;
    const color =
      role === "team_leader"
        ? "text-amber-400 bg-amber-500/15"
        : role === "senior"
          ? "text-blue-400 bg-blue-500/15"
          : role === "junior"
            ? "text-emerald-400 bg-emerald-500/15"
            : "text-slate-400 bg-slate-500/15";
    return <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-medium ${color}`}>{text}</span>;
  };

  const grouped = apiAssignDepts
    .map((dept) => ({
      dept,
      agents: apiAssignAgents.filter((agent) => agent.department_id === dept.id),
    }))
    .filter((group) => group.agents.length > 0);

  const deptIds = new Set(apiAssignDepts.map((dept) => dept.id));
  const unassigned = apiAssignAgents.filter((agent) => !agent.department_id || !deptIds.has(agent.department_id));

  const renderAgentRow = (agent: Agent) => {
    const isAssigned =
      agent.cli_provider === "api" &&
      agent.api_provider_id === apiAssignTarget.providerId &&
      agent.api_model === apiAssignTarget.model;

    return (
      <button
        key={agent.id}
        disabled={apiAssigning || isAssigned}
        onClick={() => void handleApiAssignToAgent(agent.id)}
        className={`w-full text-left px-2 py-1.5 rounded-lg text-xs transition-colors flex items-center gap-2.5 ${
          isAssigned ? "bg-green-500/10 text-green-400 cursor-default" : ""
        } disabled:opacity-60`}
        style={isAssigned ? undefined : { color: "var(--th-text-secondary)" }}
      >
        <AgentAvatar agent={agent} spriteMap={spriteMap} size={28} rounded="xl" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-medium truncate">{localName(agent.name, agent.name_ko)}</span>
            {roleBadge(agent.role)}
          </div>
          <div className="text-[10px] truncate mt-0.5" style={{ color: "var(--th-text-muted)" }}>
            {agent.cli_provider === "api" && agent.api_model ? `API: ${agent.api_model}` : agent.cli_provider}
          </div>
        </div>
        {isAssigned && <span className="text-green-400 flex-shrink-0">✓</span>}
      </button>
    );
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={() => setApiAssignTarget(null)}
    >
      <div
        className="w-96 max-h-[75vh] rounded-xl border shadow-2xl overflow-hidden"
        style={{ borderColor: "var(--th-border-strong)", background: "var(--th-card-bg)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b" style={{ borderColor: "var(--th-border)" }}>
          <h4 className="text-sm font-semibold" style={{ color: "var(--th-text-heading)" }}>
            {t({
              ko: "에이전트에 모델 배정",
              en: "Assign Model to Agent",
              ja: "エージェントにモデル割当",
              zh: "Assign Model to Agent",
              de: "Modell einem Agenten zuweisen",
            })}
          </h4>
          <p className="text-[11px] mt-0.5 font-mono truncate" style={{ color: "var(--th-text-secondary)" }}>
            {apiAssignTarget.model}
          </p>
        </div>

        <div className="max-h-[55vh] overflow-y-auto p-2 space-y-3">
          {apiAssignAgents.length === 0 ? (
            <p className="text-xs text-center py-4" style={{ color: "var(--th-text-muted)" }}>
              {t({
                ko: "에이전트를 불러오는 중...",
                en: "Loading agents...",
                ja: "エージェント読み込み中...",
                zh: "Loading agents...",
                de: "Agenten werden geladen...",
              })}
            </p>
          ) : (
            <>
              {grouped.map(({ dept, agents }) => (
                <div key={dept.id}>
                  <div
                    className="flex items-center gap-1.5 px-2 py-1.5 border-b"
                    style={{ borderColor: "var(--th-border)" }}
                  >
                    <span className="text-sm">{dept.icon}</span>
                    <span
                      className="text-[11px] font-semibold tracking-wide"
                      style={{ color: "var(--th-text-secondary)" }}
                    >
                      {localName(dept.name, dept.name_ko)}
                    </span>
                    <span className="text-[10px] text-slate-600">({agents.length})</span>
                  </div>
                  {agents.map(renderAgentRow)}
                </div>
              ))}
              {unassigned.length > 0 && (
                <div>
                  <div
                    className="flex items-center gap-1.5 px-2 py-1.5 border-b"
                    style={{ borderColor: "var(--th-border)" }}
                  >
                    <span className="text-sm">📁</span>
                    <span className="text-[11px] font-semibold tracking-wide" style={{ color: "var(--th-text-muted)" }}>
                      {t({ ko: "미배정", en: "Unassigned", ja: "未配属", zh: "Unassigned", de: "Nicht zugewiesen" })}
                    </span>
                  </div>
                  {unassigned.map(renderAgentRow)}
                </div>
              )}
            </>
          )}
        </div>

        <div className="px-4 py-2.5 border-t flex justify-end" style={{ borderColor: "var(--th-border)" }}>
          <button
            onClick={() => setApiAssignTarget(null)}
            className="text-xs px-3 py-1.5 rounded-lg transition-colors"
            style={{ background: "var(--th-bg-surface-hover)", color: "var(--th-text-secondary)" }}
          >
            {t({ ko: "닫기", en: "Close", ja: "閉じる", zh: "Close", de: "Schließen" })}
          </button>
        </div>
      </div>
    </div>
  );
}
