import type { TFunction } from "./model";

interface SkillsHeaderProps {
  t: TFunction;
  skillsCount: number;
  search: string;
  onSearchChange: (value: string) => void;
  sortBy: "rank" | "name" | "installs";
  onSortByChange: (value: "rank" | "name" | "installs") => void;
  onOpenCustomSkillModal: () => void;
}

export default function SkillsHeader({
  t,
  skillsCount,
  search,
  onSearchChange,
  sortBy,
  onSortByChange,
  onOpenCustomSkillModal,
}: SkillsHeaderProps) {
  return (
    <div
      className="backdrop-blur-sm border rounded-xl p-5"
      style={{ background: "var(--th-card-bg)", borderColor: "var(--th-border)" }}
    >
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-bold flex items-center gap-2" style={{ color: "var(--th-text-heading)" }}>
            <span className="text-2xl">📚</span>
            {t({ en: "Agent Skills Library", de: "Agent Skills Bibliothek" })}
          </h2>
          <p className="text-sm mt-1" style={{ color: "var(--th-text-secondary)" }}>
            {t({
              en: "AI agent skill directory · live skills.sh data",
              de: "KI-Agent-Skill-Verzeichnis · Live-Daten von skills.sh",
            })}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={onOpenCustomSkillModal}
            className="custom-skill-add-btn flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-violet-600/20 text-violet-300 border border-violet-500/30 rounded-lg hover:bg-violet-600/30 transition-all"
            title={t({ en: "Add custom skill", de: "Benutzerdefinierten Skill hinzufügen" })}
          >
            <span className="text-base">✏️</span>
            {t({ en: "Add Custom Skill", de: "Benutzerdefinierten Skill hinzufügen" })}
          </button>
          <div className="text-right">
            <div className="text-2xl font-bold text-amber-400">{skillsCount}</div>
            <div className="text-xs" style={{ color: "var(--th-text-muted)" }}>
              {t({ en: "Registered skills", de: "Registrierte Skills" })}
            </div>
          </div>
        </div>
      </div>

      <div className="flex gap-3">
        <div className="flex-1 relative">
          <input
            type="text"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={t({
              en: "Search skills... (name, repo, category)",
              de: "Skills suchen... (Name, Repo, Kategorie)",
            })}
            className="w-full border rounded-lg px-4 py-2.5 text-sm placeholder-slate-500 focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/25"
            style={{
              background: "var(--th-input-bg)",
              borderColor: "var(--th-input-border)",
              color: "var(--th-text-primary)",
            }}
          />
          {search && (
            <button
              onClick={() => onSearchChange("")}
              className="absolute right-3 top-1/2 -translate-y-1/2"
              style={{ color: "var(--th-text-muted)" }}
            >
              &times;
            </button>
          )}
        </div>

        <select
          value={sortBy}
          onChange={(e) => onSortByChange(e.target.value as "rank" | "name" | "installs")}
          className="border rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:border-blue-500/50"
          style={{
            background: "var(--th-input-bg)",
            borderColor: "var(--th-input-border)",
            color: "var(--th-text-primary)",
          }}
        >
          <option value="rank">{t({ en: "By Rank", de: "Nach Rang" })}</option>
          <option value="installs">{t({ en: "By Installs", de: "Nach Installationen" })}</option>
          <option value="name">{t({ en: "By Name", de: "Nach Name" })}</option>
        </select>
      </div>
    </div>
  );
}
