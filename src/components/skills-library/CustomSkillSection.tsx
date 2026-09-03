import type { CustomSkillEntry, SkillLearnProvider } from "../../api";
import { providerLabel, type TFunction } from "./model";

interface CustomSkillSectionProps {
  t: TFunction;
  customSkills: CustomSkillEntry[];
  localeTag: string;
  onDeleteSkill: (skillName: string) => void;
}

export default function CustomSkillSection({ t, customSkills, localeTag, onDeleteSkill }: CustomSkillSectionProps) {
  if (customSkills.length === 0) return null;

  return (
    <div className="custom-skill-list rounded-xl border border-violet-500/30 bg-violet-500/5 p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="text-sm font-semibold text-violet-200 flex items-center gap-2">
          <span>✏️</span>
          {t({
            ko: "커스텀 스킬",
            en: "Custom Skills",
            ja: "カスタムスキル",
            zh: "Custom Skills",
            de: "Benutzerdefinierte Skills",
          })}
          <span className="text-[11px] font-normal" style={{ color: "var(--th-text-muted)" }}>
            ({customSkills.length})
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2">
        {customSkills.map((skill) => (
          <div
            key={skill.skillName}
            className="custom-skill-card flex items-center justify-between border rounded-lg px-3 py-2"
            style={{ background: "var(--th-card-bg)", borderColor: "var(--th-border)" }}
          >
            <div className="min-w-0 flex-1">
              <div className="text-xs font-medium truncate" style={{ color: "var(--th-text-heading)" }}>
                {skill.skillName}
              </div>
              <div className="text-[10px]" style={{ color: "var(--th-text-muted)" }}>
                {skill.providers.map((provider) => providerLabel(provider as SkillLearnProvider)).join(", ")}
                {" · "}
                {new Date(skill.createdAt).toLocaleDateString(localeTag)}
              </div>
            </div>
            <button
              onClick={() => onDeleteSkill(skill.skillName)}
              className="shrink-0 ml-2 text-[10px] px-2 py-0.5 rounded border border-rose-500/30 text-rose-400 bg-rose-500/10 hover:bg-rose-500/20 transition-all"
            >
              {t({ ko: "삭제", en: "Delete", ja: "削除", zh: "Delete", de: "Löschen" })}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
