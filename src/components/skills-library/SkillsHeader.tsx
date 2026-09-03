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
            {t({
              ko: "Agent Skills 문서고",
              en: "Agent Skills Library",
              ja: "Agent Skills ライブラリ",
              zh: "Agent Skills Library",
              de: "Agent Skills Bibliothek",
            })}
          </h2>
          <p className="text-sm mt-1" style={{ color: "var(--th-text-secondary)" }}>
            {t({
              ko: "AI 에이전트 스킬 디렉토리 · skills.sh 실시간 데이터",
              en: "AI agent skill directory · live skills.sh data",
              ja: "AI エージェントスキルディレクトリ · skills.sh リアルタイムデータ",
              zh: "AI agent skill directory · live skills.sh data",
              de: "KI-Agent-Skill-Verzeichnis · Live-Daten von skills.sh",
            })}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={onOpenCustomSkillModal}
            className="custom-skill-add-btn flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-violet-600/20 text-violet-300 border border-violet-500/30 rounded-lg hover:bg-violet-600/30 transition-all"
            title={t({
              ko: "커스텀 스킬 직접 추가",
              en: "Add custom skill",
              ja: "カスタムスキルを追加",
              zh: "Add custom skill",
              de: "Benutzerdefinierten Skill hinzufügen",
            })}
          >
            <span className="text-base">✏️</span>
            {t({
              ko: "커스텀 스킬 추가",
              en: "Add Custom Skill",
              ja: "カスタムスキル追加",
              zh: "Add Custom Skill",
              de: "Benutzerdefinierten Skill hinzufügen",
            })}
          </button>
          <div className="text-right">
            <div className="text-2xl font-bold text-amber-400">{skillsCount}</div>
            <div className="text-xs" style={{ color: "var(--th-text-muted)" }}>
              {t({
                ko: "등록된 스킬",
                en: "Registered skills",
                ja: "登録済みスキル",
                zh: "Registered skills",
                de: "Registrierte Skills",
              })}
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
              ko: "스킬 검색... (이름, 저장소, 카테고리)",
              en: "Search skills... (name, repo, category)",
              ja: "スキル検索...（名前・リポジトリ・カテゴリ）",
              zh: "Search skills... (name, repo, category)",
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
          <option value="rank">
            {t({ ko: "순위순", en: "By Rank", ja: "順位順", zh: "By Rank", de: "Nach Rang" })}
          </option>
          <option value="installs">
            {t({ ko: "설치순", en: "By Installs", ja: "インストール順", zh: "By Installs", de: "Nach Installationen" })}
          </option>
          <option value="name">
            {t({ ko: "이름순", en: "By Name", ja: "名前順", zh: "By Name", de: "Nach Name" })}
          </option>
        </select>
      </div>
    </div>
  );
}
