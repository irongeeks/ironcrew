import { useCallback, useEffect, useState } from "react";
import type { Agent, Department } from "../../types";
import { useI18n } from "../../i18n";
import { getProjects } from "../../api";
import ProjectManagerContent from "../ProjectManagerContent";

interface MobileProjectsViewProps {
  agents: Agent[];
  departments: Department[];
}

type Tab = "projects" | "editor";

/**
 * Mobile-optimised Projects view with two tabs: "Projects" (sidebar list) and "Editor"
 * (detail/create panel). Selecting a project in the list auto-switches to the Editor tab.
 *
 * Implementation strategy: ProjectManagerContent already contains all the state
 * management and renders both the sidebar and content panes. On mobile we overlay
 * a tab bar and use CSS to show only the relevant pane per active tab, rather than
 * duplicating the complex state machine.
 */
export function MobileProjectsView({ agents, departments }: MobileProjectsViewProps) {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<Tab>("projects");
  const [projectCount, setProjectCount] = useState<number>(0);
  const [countLoaded, setCountLoaded] = useState(false);

  const refreshCount = useCallback(async () => {
    try {
      const res = await getProjects({ page: 1, page_size: 1 });
      setProjectCount(res.total ?? res.projects.length ?? 0);
    } catch {
      // ignore; ProjectManagerContent will surface its own errors
    } finally {
      setCountLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refreshCount();
  }, [refreshCount]);

  const tabLabel = (tab: Tab) =>
    tab === "projects"
      ? t({ ko: "프로젝트", en: "Projects", ja: "プロジェクト", zh: "项目", de: "Projekte" })
      : t({ ko: "편집기", en: "Editor", ja: "エディター", zh: "编辑器", de: "Editor" });

  const emptyHeading = t({
    ko: "선택된 프로젝트 없음",
    en: "No project selected",
    ja: "プロジェクトが選択されていません",
    zh: "未选择项目",
    de: "Kein Projekt ausgewählt",
  });
  const emptySubtitle = t({
    ko: "목록에서 프로젝트를 선택하거나 새 프로젝트를 만들어 시작하세요.",
    en: "Pick a project from the list or create a new one to get started.",
    ja: "リストからプロジェクトを選択するか、新しいプロジェクトを作成してください。",
    zh: "从列表中选择一个项目,或创建一个新项目以开始。",
    de: "Wähle ein Projekt aus der Liste oder erstelle ein neues, um loszulegen.",
  });
  const emptyCta = t({
    ko: "프로젝트 보기",
    en: "Browse Projects",
    ja: "プロジェクト一覧へ",
    zh: "查看项目",
    de: "Projekte anzeigen",
  });

  const showEmptyState = activeTab === "editor" && countLoaded && projectCount === 0;

  const tabs: Tab[] = ["projects", "editor"];

  return (
    <div className="flex h-full flex-col overflow-hidden" style={{ background: "var(--th-bg-secondary)" }}>
      {/* Tab bar */}
      <div
        className="flex flex-shrink-0 items-center gap-1 px-3 pt-2"
        style={{ borderBottom: "1px solid var(--th-border)" }}
      >
        {tabs.map((tab) => {
          const isActive = activeTab === tab;
          const showBadge = tab === "projects" && countLoaded;
          return (
            <button
              key={tab}
              type="button"
              onClick={() => setActiveTab(tab)}
              className={`relative flex min-h-[44px] items-center gap-2 rounded-t-lg px-4 transition-colors ${
                isActive ? "bg-retro-green/15 text-retro-green" : ""
              }`}
              style={{
                fontFamily: "'Press Start 2P', monospace",
                fontSize: 10,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                color: isActive ? "var(--accent)" : "var(--th-text-secondary)",
                borderBottom: isActive ? "2px solid var(--accent)" : "2px solid transparent",
              }}
            >
              <span>{tabLabel(tab)}</span>
              {showBadge ? (
                <span
                  className="rounded-full px-1.5 py-0.5 text-[10px] font-bold leading-none"
                  data-testid="mobile-projects-count-badge"
                  style={{
                    background: isActive ? "var(--accent)" : "var(--th-card-bg)",
                    color: isActive ? "var(--th-bg-primary)" : "var(--th-text-muted)",
                    fontFamily: "'JetBrains Mono', monospace",
                    minWidth: 18,
                    textAlign: "center",
                  }}
                >
                  {projectCount}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {/*
       * Content area: renders ProjectManagerContent in embedded mode.
       * We override the internal sidebar/content visibility by injecting
       * CSS that targets the internal structure based on the active tab.
       */}
      <div className="relative min-h-0 flex-1 overflow-hidden" data-mobile-projects-tab={activeTab}>
        <style>{`
          [data-mobile-projects-tab="projects"] > div > div:first-child {
            display: block !important;
            width: 100% !important;
          }
          [data-mobile-projects-tab="projects"] > div > section {
            display: none !important;
          }
          [data-mobile-projects-tab="editor"] > div > div:first-child {
            display: none !important;
          }
          [data-mobile-projects-tab="editor"] > div > section {
            display: flex !important;
            flex: 1 1 0% !important;
          }
          /* Hide the mobile "← List" back button since we have the tab bar */
          [data-mobile-projects-tab] > div > section > div.md\\:hidden {
            display: none !important;
          }
        `}</style>

        {showEmptyState ? (
          <div
            className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center"
            data-testid="mobile-projects-empty-state"
          >
            <span
              style={{
                fontFamily: "'Press Start 2P', monospace",
                fontSize: 14,
                letterSpacing: "0.04em",
                color: "var(--th-text-primary)",
                lineHeight: 1.4,
              }}
            >
              {emptyHeading}
            </span>
            <p
              className="max-w-xs"
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 12,
                color: "var(--th-text-secondary)",
                lineHeight: 1.5,
              }}
            >
              {emptySubtitle}
            </p>
            <button
              type="button"
              onClick={() => setActiveTab("projects")}
              className="min-h-[44px] rounded-lg px-5 py-2 transition-colors bg-retro-green/15 text-retro-green hover:bg-retro-green/25"
              style={{
                fontFamily: "'Press Start 2P', monospace",
                fontSize: 10,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                border: "1px solid var(--accent)",
              }}
            >
              {emptyCta}
            </button>
          </div>
        ) : (
          <div
            className="h-full"
            onClick={(e) => {
              if (activeTab !== "projects") return;
              const wrapper = e.currentTarget;
              const sidebar = wrapper.querySelector<HTMLElement>(":scope > div > div:first-child");
              if (sidebar?.contains(e.target as Node)) {
                setTimeout(() => {
                  setActiveTab("editor");
                  void refreshCount();
                }, 0);
              }
            }}
          >
            <ProjectManagerContent agents={agents} departments={departments} embedded />
          </div>
        )}
      </div>
    </div>
  );
}

export default MobileProjectsView;
