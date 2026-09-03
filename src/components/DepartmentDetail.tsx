import { useMemo } from "react";
import type React from "react";
import { localeName, useI18n } from "../i18n";
import { useMobile } from "../hooks/useMobile";
import type { Agent, Department, Task } from "../types";
import AgentAvatar from "./AgentAvatar";
import { MobileBottomSheet } from "./mobile/MobileBottomSheet";

interface DepartmentDetailProps {
  department: Department;
  agents: Agent[];
  tasks: Task[];
  onClose: () => void;
  onSelectAgent: (agent: Agent) => void;
  onChat: (agent: Agent) => void;
}

const STATUS_STYLES: Record<string, { dot: string; dotStyle?: React.CSSProperties; label: string }> = {
  working: { dot: "bg-blue-500", label: "Working" },
  idle: { dot: "bg-green-500", label: "Idle" },
  break: { dot: "bg-yellow-500", label: "Break" },
  offline: { dot: "", dotStyle: { background: "rgba(113,113,122,0.8)" }, label: "Offline" },
};

const ROLE_LABELS: Record<string, string> = {
  team_leader: "Team Leader",
  senior: "Senior",
  junior: "Junior",
  intern: "Intern",
};

export default function DepartmentDetail({
  department,
  agents,
  tasks,
  onClose,
  onSelectAgent,
  onChat,
}: DepartmentDetailProps) {
  const { t, language } = useI18n();
  const { isMobile } = useMobile();

  const deptAgents = useMemo(
    () =>
      agents
        .filter((a) => a.department_id === department.id)
        .sort((a, b) => {
          const roleOrder = ["team_leader", "senior", "junior", "intern"];
          return roleOrder.indexOf(a.role) - roleOrder.indexOf(b.role);
        }),
    [agents, department.id],
  );

  const deptTasks = useMemo(() => tasks.filter((t) => t.department_id === department.id), [tasks, department.id]);

  const activeCount = deptAgents.filter((a) => a.status === "working").length;
  const inProgressTasks = deptTasks.filter((t) => t.status === "in_progress").length;
  const doneTasks = deptTasks.filter((t) => t.status === "done").length;

  const videoPipelineTasks = useMemo(
    () =>
      deptTasks.filter(
        (task) => task.workflow_pack_key === "video_preprod" && task.status !== "done" && task.status !== "cancelled",
      ),
    [deptTasks],
  );

  const statsLine = (
    <div className="flex gap-4 mt-3 text-xs" style={{ color: "var(--th-text-secondary)" }}>
      <span>
        🤖 {deptAgents.length} {t({ ko: "명", en: "agents", ja: "名", zh: "agents", de: "Agenten" })}
      </span>
      <span>
        ⚡ {activeCount} {t({ ko: "작업중", en: "working", ja: "作業中", zh: "working", de: "aktiv" })}
      </span>
      <span>
        📋 {inProgressTasks}{" "}
        {t({ ko: "진행중", en: "in progress", ja: "進行中", zh: "in progress", de: "in Bearbeitung" })}
      </span>
      <span>
        ✅ {doneTasks}/{deptTasks.length}
      </span>
    </div>
  );

  const agentList = (
    <div className="space-y-2">
      {deptAgents.length === 0 ? (
        <p className="text-center py-8" style={{ color: "var(--th-text-muted)" }}>
          {t({
            ko: "배정된 에이전트가 없습니다",
            en: "No agents assigned",
            ja: "配属エージェントなし",
            zh: "No agents assigned",
            de: "Keine Agenten zugewiesen",
          })}
        </p>
      ) : (
        deptAgents.map((agent) => {
          const activeTask = tasks.find((task) => task.assigned_agent_id === agent.id && task.status === "in_progress");
          const statusStyle = STATUS_STYLES[agent.status] ?? STATUS_STYLES.offline;

          return (
            <div
              key={agent.id}
              className="flex items-center gap-3 p-3 cursor-pointer transition-colors group hover:opacity-90"
              style={{
                background: "var(--th-bg-surface-hover)",
                borderRadius: "var(--radius-md)",
              }}
              onClick={() => onSelectAgent(agent)}
            >
              <div className="relative shrink-0">
                <AgentAvatar
                  agent={agent}
                  agents={agents}
                  size={40}
                  rounded="xl"
                  className={agent.status === "working" ? "animate-agent-work" : ""}
                />
                <div
                  className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 ${statusStyle.dot}`}
                  style={{ borderColor: "var(--th-card-bg)", ...statusStyle.dotStyle }}
                />
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-sm truncate" style={{ color: "var(--th-text-heading)" }}>
                    {localeName(language, agent)}
                  </span>
                  <span
                    className="text-[10px] px-1.5 py-0.5 rounded"
                    style={{
                      background: "var(--th-bg-surface-hover)",
                      color: "var(--th-text-secondary)",
                    }}
                  >
                    {ROLE_LABELS[agent.role] ?? agent.role}
                  </span>
                </div>
                {activeTask ? (
                  <p className="text-xs text-blue-400 mt-0.5 truncate">💬 {activeTask.title}</p>
                ) : (
                  <p className="text-xs mt-0.5" style={{ color: "var(--th-text-muted)" }}>
                    {statusStyle.label}
                  </p>
                )}
              </div>

              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onChat(agent);
                }}
                className="shrink-0 w-8 h-8 rounded-lg flex items-center justify-center transition-colors opacity-0 group-hover:opacity-100"
                style={{
                  background: "var(--bg-glow)",
                  border: "1px solid var(--border-strong)",
                  color: "var(--th-text-secondary)",
                }}
                title={t({ ko: "채팅", en: "Chat", ja: "チャット", zh: "Chat", de: "Chat" })}
              >
                💬
              </button>
            </div>
          );
        })
      )}
    </div>
  );

  if (isMobile) {
    return (
      <MobileBottomSheet open onClose={onClose} title={localeName(language, department)}>
        {statsLine}
        {videoPipelineTasks.length > 0 && (
          <div className="mt-3">
            <VideoPipelineProgress tasks={videoPipelineTasks} t={t} />
          </div>
        )}
        <div className="mt-3 pb-4">{agentList}</div>
      </MobileBottomSheet>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div
        className="w-[calc(100vw-1.5rem)] max-w-[480px] max-h-[85vh] overflow-hidden flex flex-col"
        style={{
          background: "var(--th-card-bg)",
          border: "2px solid var(--th-card-border)",
          borderRadius: "10px 14px 10px 12px / 12px 10px 14px 10px",
          boxShadow: "8px 8px 0px var(--shadow-hard-color, rgba(0,0,0,0.4))",
        }}
      >
        {/* Header */}
        <div
          className="relative px-6 py-5 shrink-0"
          style={{
            borderBottom: "2px solid var(--th-border)",
            background: `linear-gradient(135deg, ${department.color}33, transparent)`,
          }}
        >
          <button
            onClick={onClose}
            className="font-pixel absolute top-3 right-3 w-11 h-11 flex items-center justify-center transition-all hover:-translate-y-0.5"
            style={{
              background: "var(--th-bg-surface-hover)",
              color: "var(--th-text-secondary)",
              borderRadius: "6px 8px 6px 7px",
              border: "2px solid var(--border)",
              fontSize: 10,
            }}
          >
            ✕
          </button>

          <div className="flex items-center gap-3">
            <span className="text-3xl">{department.icon || "🏢"}</span>
            <div>
              <h2
                className="font-pixel"
                style={{
                  color: "var(--th-text-heading)",
                  fontSize: 14,
                  textTransform: "uppercase",
                  letterSpacing: "0.4em",
                }}
              >
                {localeName(language, department)}
              </h2>
              {department.description && (
                <p className="text-sm mt-0.5 line-clamp-2" style={{ color: "var(--th-text-secondary)" }}>
                  {department.description}
                </p>
              )}
            </div>
          </div>

          {/* Stats */}
          {statsLine}
        </div>

        {/* Video Pipeline Progress */}
        {videoPipelineTasks.length > 0 && <VideoPipelineProgress tasks={videoPipelineTasks} t={t} />}

        {/* Agent List */}
        <div className="flex-1 overflow-y-auto p-4">{agentList}</div>
      </div>
    </div>
  );
}

const VIDEO_PIPELINE_PHASES = [
  { id: "concept", label: "Concept", icon: "💡" },
  { id: "screenplay", label: "Script", icon: "📝" },
  { id: "image_generation", label: "Images", icon: "🖼️" },
  { id: "image_review", label: "Review", icon: "🔎" },
  { id: "video_generation", label: "Video", icon: "🎬" },
  { id: "voice_prep", label: "Voice", icon: "🎙️" },
  { id: "assembly", label: "Assembly", icon: "🎞️" },
];

function VideoPipelineProgress({
  tasks,
  t,
}: {
  tasks: Task[];
  t: (messages: { ko: string; en: string; ja: string; zh: string; de?: string }) => string;
}) {
  return (
    <div className="shrink-0 px-4 py-3" style={{ borderBottom: "1px solid var(--th-border)" }}>
      <p className="mb-2 text-xs font-medium" style={{ color: "var(--th-text-secondary)" }}>
        🎬{" "}
        {t({
          ko: "비디오 파이프라인",
          en: "Video Pipeline",
          ja: "ビデオパイプライン",
          zh: "Video Pipeline",
          de: "Video-Pipeline",
        })}
        <span className="ml-1" style={{ color: "var(--th-text-muted)" }}>
          ({tasks.length})
        </span>
      </p>
      <div className="flex items-center gap-0.5 overflow-x-auto no-scrollbar">
        {VIDEO_PIPELINE_PHASES.map((phase, idx) => {
          const isActive = idx === 0;
          return (
            <div key={phase.id} className="flex items-center">
              <div
                className={`flex flex-col items-center px-1.5 py-1 rounded ${isActive ? "" : "opacity-50"}`}
                style={
                  isActive
                    ? {
                        background: "rgba(52,211,153,0.12)",
                        border: "1px solid rgba(52,211,153,0.25)",
                      }
                    : undefined
                }
              >
                <span className="text-sm">{phase.icon}</span>
                <span className="mt-0.5 text-[9px] whitespace-nowrap" style={{ color: "var(--th-text-secondary)" }}>
                  {phase.label}
                </span>
              </div>
              {idx < VIDEO_PIPELINE_PHASES.length - 1 && (
                <span className="mx-0.5 text-[8px]" style={{ color: "var(--th-text-muted)" }}>
                  →
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
