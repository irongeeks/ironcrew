import type { Project } from "../../types";
import type { ProjectI18nTranslate } from "./types";

interface ProjectSidebarProps {
  headerTitle: string;
  t: ProjectI18nTranslate;
  onClose?: () => void;
  search: string;
  setSearch: (value: string) => void;
  loadProjects: (targetPage: number, keyword: string) => Promise<void>;
  startCreate: () => void;
  onOpenGitHubImport: () => void;
  loadingList: boolean;
  projects: Project[];
  selectedProjectId: string | null;
  onSelectProject: (projectId: string) => void;
  page: number;
  totalPages: number;
}

export default function ProjectSidebar({
  headerTitle,
  t,
  onClose,
  search,
  setSearch,
  loadProjects,
  startCreate,
  onOpenGitHubImport,
  loadingList,
  projects,
  selectedProjectId,
  onSelectProject,
  page,
  totalPages,
}: ProjectSidebarProps) {
  return (
    <aside
      className="flex w-full flex-col border-r md:w-[330px]"
      style={{ borderColor: "var(--th-border)", background: "var(--th-card-bg)" }}
    >
      <div className="flex items-center justify-between border-b px-4 py-3" style={{ borderColor: "var(--th-border)" }}>
        <h2 className="text-sm font-semibold" style={{ color: "var(--th-text-heading)" }}>
          {headerTitle}
        </h2>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-xs hover:bg-[var(--th-bg-surface-hover)] hover:text-[var(--th-text-primary)]"
            style={{ color: "var(--th-text-secondary)" }}
          >
            ✕
          </button>
        )}
      </div>

      <div className="border-b px-4 py-3" style={{ borderColor: "var(--th-border)" }}>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              void loadProjects(1, search);
            }
          }}
          placeholder={t({
            ko: "프로젝트 검색",
            en: "Search projects",
            ja: "プロジェクト検索",
            zh: "Search projects",
            de: "Projekte suchen",
          })}
          className="w-full rounded-lg border px-3 py-2 text-sm outline-none focus:border-blue-500"
          style={{
            background: "var(--th-input-bg)",
            borderColor: "var(--th-input-border)",
            color: "var(--th-text-primary)",
          }}
        />
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            onClick={() => {
              void loadProjects(1, search);
            }}
            className="rounded-md px-2.5 py-1 text-xs text-[var(--th-text-primary)] hover:opacity-80"
            style={{ background: "var(--th-bg-surface-hover)" }}
          >
            {t({ ko: "조회", en: "Search", ja: "検索", zh: "Search", de: "Suchen" })}
          </button>
          <button
            type="button"
            onClick={startCreate}
            className="rounded-md px-2.5 py-1 text-xs transition"
            style={{
              background: "var(--bg-glow)",
              border: "1px solid var(--border-strong)",
              color: "var(--th-text-primary)",
            }}
          >
            {t({ ko: "신규", en: "New", ja: "新規", zh: "New", de: "Neu" })}
          </button>
          <button
            type="button"
            onClick={onOpenGitHubImport}
            className="rounded-md px-2.5 py-1 text-xs text-[var(--th-text-primary)] hover:opacity-80"
            style={{ background: "var(--th-bg-surface-hover)" }}
          >
            {t({
              ko: "GitHub 가져오기",
              en: "GitHub Import",
              ja: "GitHub インポート",
              zh: "GitHub Import",
              de: "GitHub-Import",
            })}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loadingList ? (
          <div className="px-4 py-6 text-xs" style={{ color: "var(--th-text-secondary)" }}>
            {t({ ko: "불러오는 중...", en: "Loading...", ja: "読み込み中...", zh: "Loading...", de: "Laden..." })}
          </div>
        ) : projects.length === 0 ? (
          <div className="px-4 py-6 text-xs" style={{ color: "var(--th-text-muted)" }}>
            {t({
              ko: "등록된 프로젝트가 없습니다",
              en: "No projects",
              ja: "プロジェクトなし",
              zh: "No projects",
              de: "Keine Projekte",
            })}
          </div>
        ) : (
          <div className="divide-y" style={{ borderColor: "var(--th-border)" }}>
            {projects.map((project) => (
              <button
                key={project.id}
                type="button"
                onClick={() => onSelectProject(project.id)}
                className={`w-full px-4 py-3 text-left transition ${
                  selectedProjectId === project.id ? "bg-blue-900/30" : "hover:bg-[var(--th-bg-surface-hover)]/70"
                }`}
              >
                <p
                  className="flex items-center gap-1.5 truncate text-sm font-medium"
                  style={{ color: "var(--th-text-heading)" }}
                >
                  {project.name}
                  {project.github_repo && (
                    <svg
                      className="inline-block h-3.5 w-3.5 shrink-0"
                      style={{ color: "var(--th-text-secondary)" }}
                      viewBox="0 0 16 16"
                      fill="currentColor"
                    >
                      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
                    </svg>
                  )}
                </p>
                <p className="truncate text-[11px]" style={{ color: "var(--th-text-secondary)" }}>
                  {project.project_path}
                </p>
                <p className="mt-1 truncate text-[11px]" style={{ color: "var(--th-text-muted)" }}>
                  {project.core_goal}
                </p>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between border-t px-4 py-2" style={{ borderColor: "var(--th-border)" }}>
        <button
          type="button"
          disabled={page <= 1}
          onClick={() => void loadProjects(page - 1, search)}
          className="rounded border px-2 py-1 text-xs disabled:opacity-40"
          style={{ borderColor: "var(--th-border)", color: "var(--th-text-secondary)" }}
        >
          {t({ ko: "이전", en: "Prev", ja: "前へ", zh: "Prev", de: "Zurück" })}
        </button>
        <span className="text-xs" style={{ color: "var(--th-text-muted)" }}>
          {page} / {totalPages}
        </span>
        <button
          type="button"
          disabled={page >= totalPages}
          onClick={() => void loadProjects(page + 1, search)}
          className="rounded border px-2 py-1 text-xs disabled:opacity-40"
          style={{ borderColor: "var(--th-border)", color: "var(--th-text-secondary)" }}
        >
          {t({ ko: "다음", en: "Next", ja: "次へ", zh: "Next", de: "Weiter" })}
        </button>
      </div>
    </aside>
  );
}
