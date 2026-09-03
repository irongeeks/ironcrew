import type { Dispatch, SetStateAction } from "react";
import type { ProjectDetailResponse } from "../../api";
import type { Agent, Department, Project, AssignmentMode } from "../../types";
import AgentAvatar from "../AgentAvatar";
import type { ManualAssignmentWarning, ProjectI18nTranslate, ProjectManualSelectionStats } from "./types";

interface ManualAssignmentSelectorProps {
  t: ProjectI18nTranslate;
  language: string;
  isCreating: boolean;
  editingProjectId: string | null;
  assignmentMode: AssignmentMode;
  setAssignmentMode: Dispatch<SetStateAction<AssignmentMode>>;
  setManualAssignmentWarning: Dispatch<SetStateAction<ManualAssignmentWarning | null>>;
  manualSelectionStats: ProjectManualSelectionStats;
  selectedAgentIds: Set<string>;
  setSelectedAgentIds: Dispatch<SetStateAction<Set<string>>>;
  agentFilterDept: string;
  setAgentFilterDept: Dispatch<SetStateAction<string>>;
  departments: Department[];
  agents: Agent[];
  spriteMap: Map<string, number>;
  detail: ProjectDetailResponse | null;
  selectedProject: Project | null;
}

export default function ManualAssignmentSelector({
  t,
  language,
  isCreating,
  editingProjectId,
  assignmentMode,
  setAssignmentMode,
  setManualAssignmentWarning,
  manualSelectionStats,
  selectedAgentIds,
  setSelectedAgentIds,
  agentFilterDept,
  setAgentFilterDept,
  departments,
  agents,
  spriteMap,
  detail,
  selectedProject,
}: ManualAssignmentSelectorProps) {
  return (
    <>
      {(isCreating || !!editingProjectId) && (
        <div className="mt-2 space-y-3">
          <div className="flex items-center gap-3">
            <span className="text-xs font-medium" style={{ color: "var(--th-text-secondary)" }}>
              {t({
                ko: "직원 할당 방식",
                en: "Assignment Mode",
                ja: "割り当てモード",
                zh: "Assignment Mode",
                de: "Zuweisung",
              })}
            </span>
            <div
              className="flex gap-1 rounded-lg border p-0.5"
              style={{ borderColor: "var(--th-border)", background: "var(--th-card-bg)" }}
            >
              <button
                type="button"
                onClick={() => {
                  setAssignmentMode("auto");
                  setManualAssignmentWarning(null);
                }}
                className={`rounded-md px-3 py-1 text-xs font-medium transition-all ${
                  assignmentMode === "auto" ? "bg-blue-600 text-white" : "hover:text-[var(--th-text-primary)]"
                }`}
                style={assignmentMode !== "auto" ? { color: "var(--th-text-muted)" } : undefined}
              >
                {t({ ko: "자동 할당", en: "Auto", ja: "自動", zh: "Auto", de: "Automatisch" })}
              </button>
              <button
                type="button"
                onClick={() => {
                  setAssignmentMode("manual");
                  setManualAssignmentWarning(null);
                }}
                className={`rounded-md px-3 py-1 text-xs font-medium transition-all ${
                  assignmentMode === "manual" ? "bg-violet-600 text-white" : "hover:text-[var(--th-text-primary)]"
                }`}
                style={assignmentMode !== "manual" ? { color: "var(--th-text-muted)" } : undefined}
              >
                {t({ ko: "직접 선택", en: "Manual", ja: "手動", zh: "Manual", de: "Manuell" })}
              </button>
            </div>
          </div>

          {assignmentMode === "manual" && (
            <div
              className="space-y-2 rounded-xl border p-3"
              style={{ borderColor: "var(--th-border)", background: "var(--th-card-bg)" }}
            >
              <div className="flex items-center justify-between">
                <span className="text-xs" style={{ color: "var(--th-text-secondary)" }}>
                  {t({
                    ko: "참여 직원 선택",
                    en: "Select Agents",
                    ja: "エージェント選択",
                    zh: "Select Agents",
                    de: "Agenten auswählen",
                  })}
                  <span className="ml-2 font-medium text-blue-400">
                    {selectedAgentIds.size}
                    {t({ ko: "명", en: " selected", ja: "人", zh: " selected", de: " ausgewählt" })}
                  </span>
                </span>
                {departments.length > 0 && (
                  <select
                    value={agentFilterDept}
                    onChange={(e) => setAgentFilterDept(e.target.value)}
                    className="rounded border px-2 py-1 text-[11px] outline-none"
                    style={{
                      background: "var(--th-input-bg)",
                      borderColor: "var(--th-input-border)",
                      color: "var(--th-text-primary)",
                    }}
                  >
                    <option value="all">
                      {t({ ko: "전체 부서", en: "All Depts", ja: "全部署", zh: "All Depts", de: "Alle Abteilungen" })}
                    </option>
                    {departments.map((dept) => (
                      <option key={dept.id} value={dept.id}>
                        {dept.icon} {language === "ko" ? dept.name_ko || dept.name : dept.name}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                <span
                  className="rounded-full border px-2 py-0.5"
                  style={{
                    borderColor: "var(--th-border)",
                    background: "var(--th-card-bg)",
                    color: "var(--th-text-secondary)",
                  }}
                >
                  {t({ ko: "총", en: "Total", ja: "合計", zh: "Total", de: "Gesamt" })}: {manualSelectionStats.total}
                </span>
                <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-amber-300">
                  {t({ ko: "팀장", en: "Leaders", ja: "リーダー", zh: "Leaders", de: "Teamleiter" })}:{" "}
                  {manualSelectionStats.leaders}
                </span>
                <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-emerald-300">
                  {t({ ko: "하위 직원", en: "Subordinates", ja: "サブ担当", zh: "Subordinates", de: "Mitarbeiter" })}:{" "}
                  {manualSelectionStats.subordinates}
                </span>
              </div>
              {manualSelectionStats.subordinates === 0 && (
                <p className="text-[11px] text-amber-300">
                  {t({
                    ko: "하위 직원이 없으면 실행 시 팀장이 직접(단독) 수행할 수 있습니다.",
                    en: "Without subordinates, team leaders may execute tasks directly.",
                    ja: "サブ担当がいない場合、実行時にチームリーダーが直接対応する可能性があります。",
                    zh: "Without subordinates, team leaders may execute tasks directly.",
                    de: "Ohne Mitarbeiter können Teamleiter Aufgaben direkt ausführen.",
                  })}
                </p>
              )}
              <div className="max-h-48 space-y-1 overflow-y-auto pr-1">
                {agents
                  .filter((agent) => agentFilterDept === "all" || agent.department_id === agentFilterDept)
                  .sort((a, b) => {
                    const roleOrder: Record<string, number> = {
                      team_leader: 0,
                      senior: 1,
                      junior: 2,
                      intern: 3,
                    };
                    return (roleOrder[a.role] ?? 9) - (roleOrder[b.role] ?? 9) || a.name.localeCompare(b.name);
                  })
                  .map((agent) => {
                    const checked = selectedAgentIds.has(agent.id);
                    const dept = departments.find((row) => row.id === agent.department_id);
                    return (
                      <label
                        key={agent.id}
                        className={`flex cursor-pointer items-center gap-2 rounded-lg border px-2 py-1.5 transition-all ${
                          checked
                            ? "border-blue-500/30 bg-blue-600/10"
                            : "border-transparent hover:bg-[var(--th-bg-surface-hover)]"
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => {
                            const next = new Set(selectedAgentIds);
                            if (checked) next.delete(agent.id);
                            else next.add(agent.id);
                            setSelectedAgentIds(next);
                            setManualAssignmentWarning(null);
                          }}
                          className="h-3.5 w-3.5 rounded accent-blue-500"
                          style={{ borderColor: "var(--th-border)" }}
                        />
                        <AgentAvatar agent={agent} spriteMap={spriteMap} size={24} />
                        <span className="text-xs font-medium text-[var(--th-text-primary)]">
                          {language === "ko" ? agent.name_ko || agent.name : agent.name}
                        </span>
                        {dept && (
                          <span
                            className="rounded-full px-1.5 py-0.5 text-[10px]"
                            style={{ background: `${dept.color}22`, color: dept.color }}
                          >
                            {language === "ko" ? dept.name_ko || dept.name : dept.name}
                          </span>
                        )}
                        <span
                          className="ml-auto rounded px-1.5 py-0.5 text-[10px]"
                          style={{ color: "var(--th-text-muted)", background: "var(--bg-surface-hover)" }}
                        >
                          {agent.role === "team_leader"
                            ? language === "ko"
                              ? "팀장"
                              : "Leader"
                            : agent.role === "senior"
                              ? language === "ko"
                                ? "시니어"
                                : "Senior"
                              : agent.role === "junior"
                                ? language === "ko"
                                  ? "주니어"
                                  : "Junior"
                                : agent.role === "intern"
                                  ? language === "ko"
                                    ? "인턴"
                                    : "Intern"
                                  : ""}
                        </span>
                      </label>
                    );
                  })}
              </div>
            </div>
          )}
        </div>
      )}

      {!isCreating && !editingProjectId && selectedProject && selectedProject.assignment_mode === "manual" && (
        <div className="mt-2 rounded-lg border border-violet-500/20 bg-violet-600/10 px-3 py-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-violet-400">
              {t({
                ko: "직접 선택 모드",
                en: "Manual Assignment",
                ja: "手動割り当て",
                zh: "Manual Assignment",
                de: "Manuelle Zuweisung",
              })}
            </span>
            <span className="text-xs" style={{ color: "var(--th-text-secondary)" }}>
              {detail?.assigned_agents?.length ?? 0}
              {t({ ko: "명 지정", en: " agents", ja: "人", zh: " agents", de: " Agenten" })}
            </span>
          </div>
          {detail?.assigned_agents && detail.assigned_agents.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {detail.assigned_agents.map((agent: Agent) => (
                <span
                  key={agent.id}
                  className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]"
                  style={{ background: "var(--th-card-bg)", color: "var(--th-text-secondary)" }}
                >
                  <AgentAvatar agent={agent} spriteMap={spriteMap} size={16} />
                  {language === "ko" ? agent.name_ko || agent.name : agent.name}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}
