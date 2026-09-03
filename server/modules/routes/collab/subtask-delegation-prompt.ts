import type { DbLike } from "../../../types/db-like.ts";
import type { Lang } from "../../../types/lang.ts";
import { getDepartmentPromptForPack } from "../../workflow/packs/department-scope.ts";
import type { AgentRow } from "./direct-chat.ts";
import type { L10n } from "./language-policy.ts";
import type { SubtaskRow } from "./subtask-summary.ts";

type ParentTaskRow = {
  id: string;
  title: string;
  description: string | null;
  project_id: string | null;
  project_path: string | null;
};

interface PromptDeps {
  db: DbLike;
  l: (ko: string[], en: string[], ja?: string[], zh?: string[], de?: string[]) => L10n;
  pickL: (pool: L10n, lang: Lang) => string;
  resolveLang: (text?: string, fallback?: Lang) => Lang;
  getDeptName: (deptId: string, workflowPackKey?: string | null) => string;
  getDeptRoleConstraint: (deptId: string, deptName: string) => string;
  getRecentConversationContext: (agentId: string, limit?: number) => string;
  getAgentDisplayName: (agent: AgentRow, lang: string) => string;
  buildTaskExecutionPrompt: (parts: string[], opts?: { allowWarningFix?: boolean }) => string;
  hasExplicitWarningFixRequest: (...textParts: Array<string | null | undefined>) => boolean;
}

export function createSubtaskDelegationPromptBuilder(deps: PromptDeps) {
  const {
    db,
    l,
    pickL,
    resolveLang,
    getDeptName,
    getDeptRoleConstraint,
    getRecentConversationContext,
    getAgentDisplayName,
    buildTaskExecutionPrompt,
    hasExplicitWarningFixRequest,
  } = deps;

  function buildSubtaskDelegationPrompt(
    parentTask: ParentTaskRow,
    assignedSubtasks: SubtaskRow[],
    execAgent: AgentRow,
    targetDeptId: string,
    targetDeptName: string,
  ): string {
    const lang = resolveLang(parentTask.description ?? parentTask.title);
    const assignedIds = new Set(assignedSubtasks.map((st) => st.id));
    const orderedChecklist = assignedSubtasks
      .map((st, idx) => {
        const detail = st.description ? ` - ${st.description}` : "";
        return `${idx + 1}. ${st.title}${detail}`;
      })
      .join("\n");

    const allSubtasks = db
      .prepare(
        "SELECT id, title, status, target_department_id, delegated_task_id FROM subtasks WHERE task_id = ? ORDER BY created_at",
      )
      .all(parentTask.id) as Array<{
      id: string;
      title: string;
      status: string;
      target_department_id: string | null;
      delegated_task_id: string | null;
    }>;

    const statusIcon: Record<string, string> = {
      done: "✅",
      in_progress: "🔨",
      pending: "⏳",
      blocked: "🔒",
    };

    const parentDept = db
      .prepare("SELECT department_id, workflow_pack_key FROM tasks WHERE id = ?")
      .get(parentTask.id) as { department_id: string | null; workflow_pack_key: string | null } | undefined;

    const subtaskLines = allSubtasks
      .map((st) => {
        const icon = statusIcon[st.status] || "⏳";
        const dept = st.target_department_id
          ? getDeptName(st.target_department_id, parentDept?.workflow_pack_key ?? null)
          : getDeptName(parentDept?.department_id ?? "", parentDept?.workflow_pack_key ?? null);
        const marker = assignedIds.has(st.id)
          ? pickL(
              l(
                [" ← 당신의 담당"],
                [" <- assigned to you"],
                [" ← あなたの担当"],
                [" <- 你的负责项"],
                [" <- dir zugewiesen"],
              ),
              lang,
            )
          : "";
        return `${icon} ${st.title} (${dept} - ${st.status})${marker}`;
      })
      .join("\n");

    // Collect completed sibling subtask artifacts so downstream teams can reference prior work
    const completedSiblings = allSubtasks.filter((st) => st.status === "done" && !assignedIds.has(st.id));
    let completedArtifactsBlock = "";
    if (completedSiblings.length > 0) {
      const artifactSections: string[] = [];
      for (const sibling of completedSiblings) {
        const deptName = sibling.target_department_id
          ? getDeptName(sibling.target_department_id, parentDept?.workflow_pack_key ?? null)
          : getDeptName(parentDept?.department_id ?? "", parentDept?.workflow_pack_key ?? null);

        if (sibling.delegated_task_id) {
          // Delegated subtask — collect logs from delegated task
          const recentLogs = db
            .prepare(
              "SELECT message FROM task_logs WHERE task_id = ? AND kind = 'system' ORDER BY created_at DESC LIMIT 10",
            )
            .all(sibling.delegated_task_id) as Array<{ message: string }>;
          const logSummary = recentLogs
            .map((row) => row.message)
            .filter((m) => m && !m.startsWith("RUN ") && !m.startsWith("Status →"))
            .slice(0, 5)
            .reverse()
            .join("\n  ");
          const delegatedTask = db
            .prepare("SELECT title, description, project_path FROM tasks WHERE id = ?")
            .get(sibling.delegated_task_id) as
            | { title: string; description: string | null; project_path: string | null }
            | undefined;
          const desc = delegatedTask?.description
            ? delegatedTask.description.split("\n").slice(0, 15).join("\n  ")
            : "";
          artifactSections.push(
            `[${deptName}] ${sibling.title} (DONE)` +
              (desc ? `\n  ${desc}` : "") +
              (logSummary ? `\n  ---\n  ${logSummary}` : ""),
          );
        } else {
          // Own-department subtask — completed by parent team directly (planning/documentation)
          const siblingRow = db.prepare("SELECT description FROM subtasks WHERE id = ?").get(sibling.id) as
            | { description: string | null }
            | undefined;
          const desc = siblingRow?.description ? siblingRow.description.split("\n").slice(0, 10).join("\n  ") : "";
          artifactSections.push(
            `[${deptName}] ${sibling.title} (DONE — completed by origin team)` + (desc ? `\n  ${desc}` : ""),
          );
        }
      }

      // Also include parent task's recent meaningful logs as origin team context
      const parentLogs = db
        .prepare(
          "SELECT message FROM task_logs WHERE task_id = ? AND kind = 'system' ORDER BY created_at DESC LIMIT 15",
        )
        .all(parentTask.id) as Array<{ message: string }>;
      const parentLogSummary = parentLogs
        .map((row) => row.message)
        .filter((m) => m && !m.startsWith("RUN ") && !m.startsWith("Status →") && !m.startsWith("Subtask delegation"))
        .slice(0, 5)
        .reverse()
        .join("\n  ");
      if (parentLogSummary) {
        const originDeptName = getDeptName(parentDept?.department_id ?? "", parentDept?.workflow_pack_key ?? null);
        artifactSections.unshift(
          `[${originDeptName}] ${parentTask.title} (origin task summary)\n  ${parentLogSummary}`,
        );
      }

      const completedLabel = pickL(
        l(
          ["[모체 팀 및 이전 팀 완료 산출물 — 반드시 참고하여 작업하세요]"],
          ["[Completed artifacts from origin & prior teams — use these as reference for your work]"],
          ["[元チーム及び先行チーム完了成果物 — 必ず参照して作業してください]"],
          ["[主体团队及前序团队已完成产出物 — 请务必参考进行工作]"],
          ["[Abgeschlossene Ergebnisse vom Ursprungs- & vorherigen Team — bitte als Referenz verwenden]"],
        ),
        lang,
      );
      completedArtifactsBlock = `${completedLabel}\n${artifactSections.join("\n\n")}`;
    }

    const roleLabel =
      { team_leader: "Team Leader", senior: "Senior", junior: "Junior", intern: "Intern" }[execAgent.role] ||
      execAgent.role;
    const deptConstraint = getDeptRoleConstraint(targetDeptId, targetDeptName);
    const deptPromptRaw = getDepartmentPromptForPack(
      db as any,
      parentDept?.workflow_pack_key ?? "development",
      targetDeptId,
    );
    const deptPrompt = typeof deptPromptRaw === "string" ? deptPromptRaw.trim() : "";
    const deptPromptBlock = deptPrompt ? `[Department Shared Prompt]\n${deptPrompt}` : "";
    const videoRuntimeRuleBlock =
      parentDept?.workflow_pack_key === "video_preprod"
        ? pickL(
            l(
              [
                "[Video Runtime Rules]",
                "- 렌더링 엔진은 반드시 Remotion을 사용하세요. ffmpeg 단독 합성/다른 생성기로 대체 금지.",
                "- Python(moviepy/Pillow) 기반 렌더링은 금지됩니다.",
                "- `remotion-dev/skills#remotion-best-practices` 스킬은 시스템이 자동 설치/학습 처리합니다.",
                "- 산출물은 mp4 파일로 렌더링하고 파일 경로/용량 검증을 결과에 포함하세요.",
                "- 화면 텍스트는 반드시 정제하세요: `\\n`/`\\t`/백틱/마크다운 기호를 문자 그대로 노출 금지.",
              ],
              [
                "[Video Runtime Rules]",
                "- Rendering engine must be Remotion. Do not replace it with ffmpeg-only stitching or other generators.",
                "- Python renderers (moviepy/Pillow) are forbidden.",
                "- `remotion-dev/skills#remotion-best-practices` is auto-installed/recorded by the system when missing.",
                "- Render a real mp4 artifact and include path/size verification in the result.",
                "- Sanitize all on-screen copy: never render raw `\\n`/`\\t`, backticks, or markdown symbols literally.",
              ],
              [
                "[Video Runtime Rules]",
                "- レンダリングエンジンは必ず Remotion を使用し、ffmpeg単体合成や他生成器へ置換しないでください。",
                "- Python（moviepy/Pillow）系レンダリングは使用禁止です。",
                "- `remotion-dev/skills#remotion-best-practices` が未導入ならシステムが自動インストール/学習記録します。",
                "- 実際の mp4 成果物を生成し、パス/サイズ検証を結果に含めてください。",
                "- 画面テキストは正規化し、`\\n`/`\\t`/バッククォート/Markdown記号の生表示を禁止します。",
              ],
              [
                "[Video Runtime Rules]",
                "- 渲染引擎必须使用 Remotion，不得替换为仅 ffmpeg 拼接或其他生成器。",
                "- 禁止使用 Python（moviepy/Pillow）渲染方案。",
                "- 若缺少 `remotion-dev/skills#remotion-best-practices`，系统会自动安装并记录学习。",
                "- 必须输出真实 mp4 文件，并在结果中附上路径/大小校验。",
                "- 屏幕文案必须净化：禁止把 `\\n`/`\\t`/反引号/Markdown 符号按原样显示出来。",
              ],
            ),
            lang,
          )
        : "";
    const conversationCtx = getRecentConversationContext(execAgent.id);
    const agentDisplayName = getAgentDisplayName(execAgent, lang);
    const header = pickL(
      l(
        [`[프로젝트 협업 업무 - ${targetDeptName}]`],
        [`[Project collaboration task - ${targetDeptName}]`],
        [`[プロジェクト協業タスク - ${targetDeptName}]`],
        [`[项目协作任务 - ${targetDeptName}]`],
        [`[Projekt-Zusammenarbeit - ${targetDeptName}]`],
      ),
      lang,
    );
    const originalTaskLabel = pickL(
      l(["원본 업무"], ["Original task"], ["元タスク"], ["原始任务"], ["Ursprungsaufgabe"]),
      lang,
    );
    const ceoRequestLabel = pickL(l(["CEO 요청"], ["CEO request"], ["CEO依頼"], ["CEO指示"], ["CEO-Anfrage"]), lang);
    const allSubtasksLabel = pickL(
      l(
        ["전체 서브태스크 현황"],
        ["All subtask status"],
        ["全サブタスク状況"],
        ["全部 SubTask 状态"],
        ["Gesamtstatus aller Unteraufgaben"],
      ),
      lang,
    );
    const deptOwnedLabel = pickL(
      l(
        [`[${targetDeptName} 담당 업무 묶음]`],
        [`[${targetDeptName} owned batch]`],
        [`[${targetDeptName}担当タスク一式]`],
        [`[${targetDeptName}负责项集合]`],
        [`[${targetDeptName} zugewiesenes Paket]`],
      ),
      lang,
    );
    const checklistLabel = pickL(
      l(
        ["순차 실행 체크리스트"],
        ["Sequential execution checklist"],
        ["順次実行チェックリスト"],
        ["顺序执行清单"],
        ["Sequentielle Ausführungs-Checkliste"],
      ),
      lang,
    );
    const finalInstruction = pickL(
      l(
        [
          "위 순차 체크리스트를 1번부터 끝까지 순서대로 처리하고, 중간에 분할하지 말고 한 번의 작업 흐름으로 완료하세요.",
        ],
        [
          "Execute the checklist in order from 1 to end, and finish it in one continuous run without splitting into separate requests.",
        ],
        ["上記チェックリストを1番から順番に実行し、分割せず1回の作業フローで完了してください。"],
        ["请按 1 到末尾顺序执行清单，不要拆分为多次请求，在一次连续流程中完成。"],
        [
          "Führe die Checkliste der Reihe nach von 1 bis Ende aus und schließe sie in einem durchgängigen Lauf ab, ohne sie in separate Anfragen aufzuteilen.",
        ],
      ),
      lang,
    );

    return buildTaskExecutionPrompt(
      [
        header,
        ``,
        `${originalTaskLabel}: ${parentTask.title}`,
        parentTask.description ? `${ceoRequestLabel}: ${parentTask.description}` : "",
        ``,
        `[${allSubtasksLabel}]`,
        subtaskLines,
        completedArtifactsBlock ? `\n${completedArtifactsBlock}` : "",
        ``,
        deptOwnedLabel,
        `${checklistLabel}:`,
        orderedChecklist,
        conversationCtx ? `\n${conversationCtx}` : "",
        ``,
        `---`,
        `Agent: ${agentDisplayName} (${roleLabel}, ${targetDeptName})`,
        execAgent.personality ? `Personality: ${execAgent.personality}` : "",
        deptConstraint,
        deptPromptBlock,
        videoRuntimeRuleBlock,
        ``,
        finalInstruction,
      ],
      {
        allowWarningFix: hasExplicitWarningFixRequest(
          parentTask.title,
          parentTask.description,
          assignedSubtasks.map((st) => st.title).join(" / "),
          assignedSubtasks
            .map((st) => st.description)
            .filter((v): v is string => !!v)
            .join(" / "),
        ),
      },
    );
  }

  return { buildSubtaskDelegationPrompt };
}
