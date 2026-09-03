import { localeName, type UiLanguage } from "../../i18n";
import type { Agent, Department, WorkflowPackKey } from "../../types";
import AgentAvatar from "../AgentAvatar";
import CliEditorInline from "./CliEditorInline";
import { roleLabel, statusLabel, type TFunction } from "./constants";
import type { AgentDetailState } from "./useAgentDetailState";

interface AgentDetailHeaderProps {
  agent: Agent;
  agents: Agent[];
  department: Department | undefined;
  state: AgentDetailState;
  activeOfficeWorkflowPack: WorkflowPackKey;
  onClose: () => void;
  t: TFunction;
  language: UiLanguage;
}

export default function AgentDetailHeader({
  agent,
  agents,
  department,
  state,
  activeOfficeWorkflowPack: _activeOfficeWorkflowPack /* used by useAgentDetailState */,
  onClose,
  t,
  language,
}: AgentDetailHeaderProps) {
  const { statusCfg, actsAsPlanningLead, savingPlanningLead, handlePlanningLeadToggle } = state;

  return (
    <div
      className="relative px-6 py-5"
      style={{
        borderBottom: "1px solid var(--th-border)",
        background: department ? `linear-gradient(135deg, ${department.color}22, transparent)` : undefined,
      }}
    >
      <button
        onClick={onClose}
        className="absolute top-3 right-3 w-8 h-8 flex items-center justify-center transition-colors"
        style={{
          background: "var(--th-bg-surface-hover)",
          color: "var(--th-text-secondary)",
          borderRadius: "var(--radius-full)",
        }}
      >
        ✕
      </button>

      <div className="flex items-center gap-4">
        <div className="relative">
          <AgentAvatar
            agent={agent}
            agents={agents}
            size={64}
            rounded="2xl"
            className={agent.status === "working" ? "animate-agent-work" : ""}
          />
          <div
            className="absolute -bottom-1 -right-1 w-4 h-4 rounded-full border-2"
            style={{
              borderColor: "var(--th-card-bg)",
              background:
                agent.status === "working"
                  ? "var(--accent)"
                  : agent.status === "idle"
                    ? "#6B7280"
                    : agent.status === "break"
                      ? "#FBBF24"
                      : "rgba(113,113,122,0.8)",
            }}
          />
        </div>

        <div className="flex-1">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-bold" style={{ color: "var(--th-text-heading)" }}>
              {localeName(language, agent)}
            </h2>
            <span className={`text-xs px-1.5 py-0.5 rounded ${statusCfg.bg} ${statusCfg.color}`}>
              {statusLabel(statusCfg.label, t)}
            </span>
          </div>
          <div className="text-sm mt-0.5" style={{ color: "var(--th-text-secondary)" }}>
            {department?.icon} {department ? localeName(language, department) : ""} · {roleLabel(agent.role, t)}
          </div>
          {agent.role === "team_leader" && (
            <label
              className="mt-1 inline-flex items-center gap-1.5 text-xs"
              style={{ color: "var(--th-text-secondary)" }}
            >
              <input
                type="checkbox"
                checked={actsAsPlanningLead}
                disabled={savingPlanningLead}
                onChange={(event) => {
                  void handlePlanningLeadToggle(event.target.checked);
                }}
                className="h-3.5 w-3.5 rounded text-blue-500 focus:ring-blue-500/50 disabled:opacity-60"
                style={{ background: "var(--th-input-bg)", borderColor: "var(--th-input-border)" }}
              />
              <span>
                {t({
                  ko: "Lead (기획 리더)",
                  en: "Lead (Planning lead)",
                  ja: "Lead（企画リード）",
                  zh: "Lead (Planning lead)",
                  de: "Lead (Planungsleiter)",
                })}
              </span>
              {savingPlanningLead && (
                <span className="text-[10px]" style={{ color: "var(--th-text-secondary)" }}>
                  {t({ ko: "저장중...", en: "Saving...", ja: "保存中...", zh: "Saving...", de: "Wird gespeichert..." })}
                </span>
              )}
            </label>
          )}
          <div className="text-xs mt-0.5" style={{ color: "var(--th-text-muted)" }}>
            <CliEditorInline agent={agent} state={state} t={t} />
          </div>
        </div>
      </div>
    </div>
  );
}
