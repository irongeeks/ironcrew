import type { Agent, Department } from "../../types";
import { useI18n } from "../../i18n";
import AgentSelect from "../AgentSelect";
import { TASK_TYPE_OPTIONS, taskTypeLabel } from "./constants";

interface FilterBarProps {
  agents: Agent[];
  departments: Department[];
  filterDept: string;
  filterAgent: string;
  filterType: string;
  search: string;
  onFilterDept: (value: string) => void;
  onFilterAgent: (value: string) => void;
  onFilterType: (value: string) => void;
  onSearch: (value: string) => void;
}

export default function FilterBar({
  agents,
  departments,
  filterDept,
  filterAgent,
  filterType,
  search,
  onFilterDept,
  onFilterAgent,
  onFilterType,
  onSearch,
}: FilterBarProps) {
  const { t } = useI18n();

  return (
    <div className="flex flex-wrap items-center gap-2.5">
      <div className="relative min-w-[140px] flex-[1_1_100%] sm:min-w-[180px] sm:flex-1">
        <span
          className="absolute left-2.5 top-1/2 -translate-y-1/2 text-sm"
          style={{ color: "var(--th-text-secondary)" }}
        >
          🔎
        </span>
        <input
          type="text"
          value={search}
          onChange={(event) => onSearch(event.target.value)}
          placeholder={t({ en: "Search tasks...", de: "Aufgaben suchen..." })}
          className="min-h-10 w-full rounded-lg border py-2 pl-8 pr-3 text-sm placeholder-slate-500 outline-none transition focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
          style={{
            background: "var(--th-input-bg)",
            borderColor: "var(--th-input-border)",
            color: "var(--th-text-primary)",
          }}
        />
      </div>

      <select
        value={filterDept}
        onChange={(event) => onFilterDept(event.target.value)}
        className="min-h-10 flex-1 rounded-lg border px-3 py-2 text-sm outline-none transition focus:border-blue-500 sm:flex-none"
        style={{
          background: "var(--th-input-bg)",
          borderColor: "var(--th-input-border)",
          color: "var(--th-text-primary)",
        }}
      >
        <option value="">{t({ en: "All Departments", de: "Alle Abteilungen" })}</option>
        {departments.map((department) => (
          <option key={department.id} value={department.id}>
            {department.icon} {department.name}
          </option>
        ))}
      </select>

      <AgentSelect
        agents={agents}
        departments={departments}
        value={filterAgent}
        onChange={onFilterAgent}
        placeholder={t({ en: "All Agents", de: "Alle Agents" })}
        size="md"
      />

      <select
        value={filterType}
        onChange={(event) => onFilterType(event.target.value)}
        className="min-h-10 flex-1 rounded-lg border px-3 py-2 text-sm outline-none transition focus:border-blue-500 sm:flex-none"
        style={{
          background: "var(--th-input-bg)",
          borderColor: "var(--th-input-border)",
          color: "var(--th-text-primary)",
        }}
      >
        <option value="">{t({ en: "All Types", de: "Alle Typen" })}</option>
        {TASK_TYPE_OPTIONS.map((typeOption) => (
          <option key={typeOption.value} value={typeOption.value}>
            {taskTypeLabel(typeOption.value, t)}
          </option>
        ))}
      </select>
    </div>
  );
}
