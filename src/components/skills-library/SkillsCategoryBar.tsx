import { CATEGORIES, CATEGORY_ICONS, categoryLabel, type TFunction } from "./model";

interface SkillsCategoryBarProps {
  t: TFunction;
  selectedCategory: string;
  onSelectCategory: (category: string) => void;
  categoryCounts: Record<string, number>;
  filteredLength: number;
  search: string;
}

export default function SkillsCategoryBar({
  t,
  selectedCategory,
  onSelectCategory,
  categoryCounts,
  filteredLength,
  search,
}: SkillsCategoryBarProps) {
  return (
    <>
      <div className="flex flex-wrap gap-2">
        {CATEGORIES.map((category) => (
          <button
            key={category}
            onClick={() => onSelectCategory(category)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${
              selectedCategory === category ? "bg-blue-600/20 text-blue-400 border-blue-500/40" : ""
            }`}
            style={
              selectedCategory !== category
                ? {
                    background: "var(--th-card-bg)",
                    color: "var(--th-text-secondary)",
                    borderColor: "var(--th-border)",
                  }
                : undefined
            }
          >
            {CATEGORY_ICONS[category]} {categoryLabel(category, t)}
            <span className="ml-1" style={{ color: "var(--th-text-muted)" }}>
              {categoryCounts[category] || 0}
            </span>
          </button>
        ))}
      </div>

      <div className="text-xs px-1" style={{ color: "var(--th-text-muted)" }}>
        {filteredLength}
        {t({
          ko: "개 스킬 표시중",
          en: " skills shown",
          ja: "件のスキルを表示中",
          zh: " skills shown",
          de: " Skills angezeigt",
        })}
        {search &&
          ` · "${search}" ${t({ ko: "검색 결과", en: "search results", ja: "検索結果", zh: "search results", de: "Suchergebnisse" })}`}
      </div>
    </>
  );
}
