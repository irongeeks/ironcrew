import { useState, useRef, useEffect, useMemo } from "react";
import type { Agent, Department } from "../types";
import AgentAvatar, { useSpriteMap } from "./AgentAvatar";
import { useI18n, localeName } from "../i18n";
import type { LangText } from "../i18n";

interface AgentSelectProps {
  agents: Agent[];
  departments?: Department[];
  value: string;
  onChange: (agentId: string) => void;
  placeholder?: string;
  size?: "sm" | "md";
  className?: string;
}

const ROLE_LABELS: Record<string, LangText> = {
  team_leader: { ko: "팀장", en: "Team Leader", ja: "チームリーダー", zh: "Team Leader", de: "Teamleiter" },
  senior: { ko: "시니어", en: "Senior", ja: "シニア", zh: "Senior", de: "Senior" },
  junior: { ko: "주니어", en: "Junior", ja: "ジュニア", zh: "Junior", de: "Junior" },
  intern: { ko: "인턴", en: "Intern", ja: "インターン", zh: "Intern", de: "Praktikant" },
};

export default function AgentSelect({
  agents,
  departments,
  value,
  onChange,
  placeholder,
  size = "sm",
  className = "",
}: AgentSelectProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const spriteMap = useSpriteMap(agents);
  const { t, locale } = useI18n();
  const selected = agents.find((a) => a.id === value);
  const departmentById = useMemo(() => {
    const map = new Map<string, Department>();
    for (const dept of departments ?? []) {
      map.set(dept.id, dept);
    }
    return map;
  }, [departments]);

  const textSize = size === "md" ? "text-sm" : "text-xs";
  const padY = size === "md" ? "py-2" : "py-1";
  const avatarSize = size === "md" ? 22 : 18;

  const tr = (ko: string, en: string, ja = en, zh = en, de = en) => t({ ko, en, ja, zh, de });

  const getAgentName = (agent: Agent) => localeName(locale, agent);

  const getRoleLabel = (role: string) => {
    const label = ROLE_LABELS[role];
    return label ? t(label) : role;
  };

  const getDepartmentLabel = (agent: Agent) => {
    const dept = agent.department ?? (agent.department_id ? departmentById.get(agent.department_id) : undefined);
    if (!dept) return "";
    return localeName(locale, dept);
  };

  const effectivePlaceholder =
    placeholder ??
    tr("-- 담당자 없음 --", "-- Unassigned --", "-- 担当者なし --", "-- 无负责人 --", "-- Nicht zugewiesen --");

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  return (
    <div ref={ref} className={`relative ${className}`}>
      {/* Trigger */}
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={`w-full flex items-center gap-2 px-2 ${padY} rounded-lg border ${textSize} outline-none transition hover:border-slate-500 focus:border-blue-500`}
        style={{
          background: "var(--th-input-bg)",
          borderColor: "var(--th-input-border)",
          color: "var(--th-text-primary)",
        }}
      >
        {selected ? (
          <>
            <AgentAvatar agent={selected} spriteMap={spriteMap} size={avatarSize} />
            <span className="truncate">{getAgentName(selected)}</span>
            <span className="text-[10px]" style={{ color: "var(--th-text-muted)" }}>
              ({getRoleLabel(selected.role)})
            </span>
            {getDepartmentLabel(selected) && (
              <span className="text-[10px]" style={{ color: "var(--th-text-muted)" }}>
                · {getDepartmentLabel(selected)}
              </span>
            )}
          </>
        ) : (
          <span style={{ color: "var(--th-text-muted)" }}>{effectivePlaceholder}</span>
        )}
        <svg
          className="ml-auto w-3 h-3 flex-shrink-0"
          style={{ color: "var(--th-text-muted)" }}
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M3 5l3 3 3-3" />
        </svg>
      </button>

      {/* Dropdown */}
      {open && (
        <div
          className="absolute z-50 mt-1 w-full max-h-48 overflow-y-auto rounded-lg border shadow-xl"
          style={{ borderColor: "var(--th-border-strong)", background: "var(--th-card-bg)" }}
        >
          {/* None option */}
          <button
            type="button"
            onClick={() => {
              onChange("");
              setOpen(false);
            }}
            className={`w-full flex items-center gap-2 px-2 ${padY} ${textSize} hover:opacity-80 transition-colors`}
            style={{ color: "var(--th-text-muted)" }}
          >
            {effectivePlaceholder}
          </button>

          {agents.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => {
                onChange(a.id);
                setOpen(false);
              }}
              className={`w-full flex items-center gap-2 px-2 ${padY} ${textSize} transition-colors ${
                a.id === value ? "bg-blue-600/20 text-blue-300" : "hover:opacity-80"
              }`}
              style={a.id !== value ? { color: "var(--th-text-secondary)" } : undefined}
            >
              <AgentAvatar agent={a} spriteMap={spriteMap} size={avatarSize} />
              <span className="truncate">{getAgentName(a)}</span>
              <span className="text-[10px]" style={{ color: "var(--th-text-muted)" }}>
                ({getRoleLabel(a.role)})
              </span>
              {getDepartmentLabel(a) && (
                <span className="text-[10px]" style={{ color: "var(--th-text-muted)" }}>
                  · {getDepartmentLabel(a)}
                </span>
              )}
              {a.status === "working" && (
                <span className="ml-auto w-1.5 h-1.5 rounded-full bg-blue-400 flex-shrink-0" />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
