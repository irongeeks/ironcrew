import type { Project } from "../../types";

type ProjectFlowStep = "choose" | "existing" | "new" | "confirm";

type Tr = (ko: string, en: string, ja?: string, zh?: string, de?: string) => string;

interface ProjectFlowDialogProps {
  open: boolean;
  step: ProjectFlowStep;
  isDirectivePending: boolean;
  pendingContent: string;
  projectLoading: boolean;
  projectItems: Project[];
  selectedProject: Project | null;
  existingProjectInput: string;
  existingProjectError: string;
  newProjectError: string;
  newProjectName: string;
  newProjectPath: string;
  newProjectGoal: string;
  projectSaving: boolean;
  canCreateProject: boolean;
  tr: Tr;
  onClose: () => void;
  onChooseExisting: () => void;
  onChooseNew: () => void;
  onBackToChoose: () => void;
  onSelectExistingProject: (project: Project, index: number) => void;
  onExistingProjectInputChange: (value: string) => void;
  onApplyExistingProjectSelection: () => void;
  onNewProjectNameChange: (value: string) => void;
  onNewProjectPathChange: (value: string) => void;
  onNewProjectGoalChange: (value: string) => void;
  onCreateProject: () => void;
  onConfirm: () => void;
}

export default function ProjectFlowDialog({
  open,
  step,
  isDirectivePending,
  pendingContent,
  projectLoading,
  projectItems,
  selectedProject,
  existingProjectInput,
  existingProjectError,
  newProjectError,
  newProjectName,
  newProjectPath,
  newProjectGoal,
  projectSaving,
  canCreateProject,
  tr,
  onClose,
  onChooseExisting,
  onChooseNew,
  onBackToChoose,
  onSelectExistingProject,
  onExistingProjectInputChange,
  onApplyExistingProjectSelection,
  onNewProjectNameChange,
  onNewProjectPathChange,
  onNewProjectGoalChange,
  onCreateProject,
  onConfirm,
}: ProjectFlowDialogProps) {
  if (!open) return null;

  return (
    <div className="absolute inset-0 z-[70] flex items-center justify-center bg-black/75 p-4">
      <div
        className="max-h-full w-full max-w-md overflow-y-auto rounded-xl border shadow-2xl"
        style={{ borderColor: "var(--th-border)", background: "var(--th-card-bg)" }}
      >
        <div
          className="flex items-center justify-between border-b px-4 py-3"
          style={{ borderColor: "var(--th-border)" }}
        >
          <h3 className="text-sm font-semibold" style={{ color: "var(--th-text-heading)" }}>
            {tr("프로젝트 분기", "Project Branch", "プロジェクト分岐", "项目分支", "Projektzweig")}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-xs hover:bg-[var(--th-bg-surface-hover)] hover:text-white"
            style={{ color: "var(--th-text-secondary)" }}
          >
            ✕
          </button>
        </div>

        <div className="space-y-3 px-4 py-4 text-sm">
          {step === "choose" && (
            <>
              <p className="text-[var(--th-text-primary)]">
                {tr(
                  "기존 프로젝트인가요? 신규 프로젝트인가요?",
                  "Is this an existing project or a new project?",
                  "既存プロジェクトですか？新規プロジェクトですか？",
                  "这是已有项目还是新项目？",
                  "Handelt es sich um ein vorhandenes oder neues Projekt?",
                )}
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={onChooseExisting}
                  className="flex-1 rounded-lg bg-blue-600 px-3 py-2 text-xs font-medium text-white hover:bg-blue-500"
                >
                  {tr("기존 프로젝트", "Existing Project", "既存プロジェクト", "已有项目", "Vorhandenes Projekt")}
                </button>
                <button
                  type="button"
                  onClick={onChooseNew}
                  className="flex-1 rounded-lg bg-emerald-600 px-3 py-2 text-xs font-medium text-white hover:bg-emerald-500"
                >
                  {tr("신규 프로젝트", "New Project", "新規プロジェクト", "新项目", "Neues Projekt")}
                </button>
              </div>
            </>
          )}

          {step === "existing" && (
            <>
              <p className="text-xs" style={{ color: "var(--th-text-secondary)" }}>
                {tr(
                  "최근 프로젝트 10개를 보여드립니다. 번호(1-10) 또는 프로젝트명을 입력하세요.",
                  "Showing 10 recent projects. Enter a number (1-10) or project name.",
                  "最新プロジェクト10件を表示します。番号(1-10)またはプロジェクト名を入力してください。",
                  "显示最近 10 个项目。请输入编号(1-10)或项目名称。",
                  "Die letzten 10 Projekte werden angezeigt. Nummer (1-10) oder Projektname eingeben.",
                )}
              </p>
              {projectLoading ? (
                <p className="text-xs" style={{ color: "var(--th-text-muted)" }}>
                  {tr("불러오는 중...", "Loading...", "読み込み中...", "加载中...", "Wird geladen...")}
                </p>
              ) : projectItems.length === 0 ? (
                <p className="text-xs" style={{ color: "var(--th-text-muted)" }}>
                  {tr("프로젝트가 없습니다", "No projects", "プロジェクトなし", "暂无项目", "Keine Projekte")}
                </p>
              ) : (
                <div className="max-h-52 space-y-2 overflow-y-auto pr-1">
                  {projectItems.map((project, idx) => (
                    <div
                      key={project.id}
                      className="rounded-lg border p-2"
                      style={{ borderColor: "var(--th-border)", background: "var(--th-card-bg)" }}
                    >
                      <p className="text-xs font-medium text-slate-100">
                        <span className="mr-1 text-blue-300">{idx + 1}.</span>
                        {project.name}
                      </p>
                      <p className="truncate text-[11px]" style={{ color: "var(--th-text-secondary)" }}>
                        {project.project_path}
                      </p>
                      <button
                        type="button"
                        onClick={() => onSelectExistingProject(project, idx)}
                        className="mt-2 rounded bg-blue-700 px-2 py-1 text-[11px] text-white hover:bg-blue-600"
                      >
                        {tr("선택", "Select", "選択", "选择", "Auswählen")}
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div className="space-y-2 pt-1">
                <input
                  type="text"
                  value={existingProjectInput}
                  onChange={(e) => onExistingProjectInputChange(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      onApplyExistingProjectSelection();
                    }
                  }}
                  placeholder={tr(
                    "예: 1 또는 프로젝트명",
                    "e.g. 1 or project name",
                    "例: 1 またはプロジェクト名",
                    "例如：1 或项目名",
                    "z.B. 1 oder Projektname",
                  )}
                  className="w-full rounded border px-2 py-1.5 text-xs outline-none focus:border-blue-500"
                  style={{
                    background: "var(--th-input-bg)",
                    borderColor: "var(--th-input-border)",
                    color: "var(--th-text-primary)",
                  }}
                />
                {existingProjectError && <p className="text-[11px] text-rose-300">{existingProjectError}</p>}
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={onApplyExistingProjectSelection}
                    className="flex-1 rounded bg-blue-700 px-2 py-1.5 text-[11px] text-white hover:bg-blue-600"
                  >
                    {tr("입력값으로 선택", "Select from input", "入力値で選択", "按输入选择", "Aus Eingabe auswählen")}
                  </button>
                  <button
                    type="button"
                    onClick={onBackToChoose}
                    className="rounded border px-2 py-1.5 text-[11px]"
                    style={{ borderColor: "var(--th-border)", color: "var(--th-text-secondary)" }}
                  >
                    {tr("뒤로", "Back", "戻る", "返回", "Zurück")}
                  </button>
                </div>
              </div>
            </>
          )}

          {step === "new" && (
            <>
              <input
                type="text"
                value={newProjectName}
                onChange={(e) => onNewProjectNameChange(e.target.value)}
                placeholder={tr("프로젝트 이름", "Project name", "プロジェクト名", "项目名称", "Projektname")}
                className="w-full rounded-lg border px-3 py-2 text-xs outline-none focus:border-blue-500"
                style={{
                  background: "var(--th-input-bg)",
                  borderColor: "var(--th-input-border)",
                  color: "var(--th-text-primary)",
                }}
              />
              <input
                type="text"
                value={newProjectPath}
                onChange={(e) => onNewProjectPathChange(e.target.value)}
                placeholder={tr("프로젝트 경로", "Project path", "プロジェクトパス", "项目路径", "Projektpfad")}
                className={`w-full rounded-lg border px-3 py-2 text-xs outline-none focus:border-blue-500 ${newProjectError ? "border-rose-500" : ""}`}
                style={{
                  background: "var(--th-input-bg)",
                  borderColor: newProjectError ? undefined : "var(--th-input-border)",
                  color: "var(--th-text-primary)",
                }}
              />
              {newProjectError && <p className="text-[11px] text-rose-300">{newProjectError}</p>}
              <textarea
                rows={3}
                value={newProjectGoal}
                onChange={(e) => onNewProjectGoalChange(e.target.value)}
                readOnly={isDirectivePending}
                placeholder={tr("핵심 목표", "Core goal", "コア目標", "核心目标", "Kernziel")}
                className="w-full resize-none rounded-lg border px-3 py-2 text-xs outline-none focus:border-blue-500"
                style={{
                  background: "var(--th-input-bg)",
                  borderColor: "var(--th-input-border)",
                  color: "var(--th-text-primary)",
                }}
              />
              {isDirectivePending && (
                <p className="text-[11px]" style={{ color: "var(--th-text-secondary)" }}>
                  {tr(
                    "$ 업무지시 내용이 신규 프로젝트의 핵심 목표로 자동 반영됩니다.",
                    "The $ directive text is automatically used as the new project core goal.",
                    "$業務指示の内容が新規プロジェクトのコア目標として自動反映されます。",
                    "$ 指令内容会自动作为新项目核心目标。",
                    "Der $-Anweisungstext wird automatisch als Kernziel des neuen Projekts verwendet.",
                  )}
                </p>
              )}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={onCreateProject}
                  disabled={!canCreateProject || projectSaving}
                  className="flex-1 rounded bg-emerald-700 px-3 py-2 text-xs font-medium text-white hover:bg-emerald-600 disabled:opacity-40"
                >
                  {projectSaving
                    ? tr("등록 중...", "Creating...", "作成中...", "创建中...", "Wird erstellt...")
                    : tr("등록 후 선택", "Create & Select", "作成して選択", "创建并选择", "Erstellen & Auswählen")}
                </button>
                <button
                  type="button"
                  onClick={onBackToChoose}
                  className="rounded border px-3 py-2 text-xs"
                  style={{ borderColor: "var(--th-border)", color: "var(--th-text-secondary)" }}
                >
                  {tr("뒤로", "Back", "戻る", "返回")}
                </button>
              </div>
            </>
          )}

          {step === "confirm" && selectedProject && (
            <>
              <div
                className="max-h-36 overflow-y-auto rounded-lg border p-3"
                style={{ borderColor: "var(--th-border)", background: "var(--th-card-bg)" }}
              >
                <p className="text-xs font-semibold" style={{ color: "var(--th-text-heading)" }}>
                  {selectedProject.name}
                </p>
                <p className="mt-1 text-[11px]" style={{ color: "var(--th-text-secondary)" }}>
                  {selectedProject.project_path}
                </p>
                <p className="mt-1 text-[11px]" style={{ color: "var(--th-text-secondary)" }}>
                  {selectedProject.core_goal}
                </p>
                {selectedProject.assignment_mode === "manual" && (
                  <div className="mt-2 flex items-center gap-1.5 text-[11px] text-violet-300">
                    <span className="inline-block h-2 w-2 rounded-full bg-violet-400"></span>
                    {tr(
                      `직접 선택 모드 — 지정된 ${selectedProject.assigned_agent_ids?.length ?? 0}명의 직원이 작업합니다`,
                      `Manual mode — ${selectedProject.assigned_agent_ids?.length ?? 0} assigned agents will work on this`,
                      `手動モード — ${selectedProject.assigned_agent_ids?.length ?? 0}名の指定エージェントが作業します`,
                      `手动模式 — ${selectedProject.assigned_agent_ids?.length ?? 0}名指定员工将执行此任务`,
                      `Manueller Modus — ${selectedProject.assigned_agent_ids?.length ?? 0} zugewiesene Agenten werden daran arbeiten`,
                    )}
                  </div>
                )}
              </div>
              <div className="max-h-40 overflow-y-auto rounded-lg border border-blue-700/40 bg-blue-900/20 p-3 text-[11px] text-blue-100">
                <p className="font-medium">
                  {tr("라운드 목표", "Round Goal", "ラウンド目標", "回合目标", "Rundenziel")}
                </p>
                <p className="mt-1 leading-relaxed">
                  {tr(
                    `프로젝트 핵심목표(${selectedProject.core_goal})를 기준으로 이번 요청(${pendingContent})을 실행 가능한 산출물로 완수`,
                    `Execute this round with project core goal (${selectedProject.core_goal}) and current request (${pendingContent}).`,
                    `プロジェクト目標(${selectedProject.core_goal})と今回依頼(${pendingContent})を基準に実行可能な成果物を完了します。`,
                    `以项目核心目标（${selectedProject.core_goal}）和本次请求（${pendingContent}）为基础完成本轮可执行产出。`,
                    `Diese Runde mit Projektziel (${selectedProject.core_goal}) und aktueller Anfrage (${pendingContent}) abschließen.`,
                  )}
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={onConfirm}
                  className="flex-1 rounded bg-blue-600 px-3 py-2 text-xs font-medium text-white hover:bg-blue-500"
                >
                  {tr("선택 후 전송", "Select & Send", "選択して送信", "选择并发送", "Auswählen & Senden")}
                </button>
                <button
                  type="button"
                  onClick={onBackToChoose}
                  className="rounded border px-3 py-2 text-xs"
                  style={{ borderColor: "var(--th-border)", color: "var(--th-text-secondary)" }}
                >
                  {tr("다시 선택", "Re-select", "再選択", "重新选择", "Neu auswählen")}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
