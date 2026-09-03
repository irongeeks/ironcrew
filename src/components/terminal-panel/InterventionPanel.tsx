import type { Task } from "../../types";
import { INTERVENTION_PROMPT_MAX_LENGTH } from "./model";
import type { InterruptProof } from "./useTerminalData";

type TrFn = (ko: string, en: string, ja?: string, zh?: string, de?: string) => string;

export interface InterventionPanelProps {
  task: Task | undefined;
  interventionPrompt: string;
  setInterventionPrompt: (value: string) => void;
  interventionBusy: boolean;
  interventionError: string | null;
  interventionMessage: string | null;
  interruptProof: InterruptProof | null;
  hasAssignedAgent: boolean;
  canInjectPrompt: boolean;
  canAttemptInterrupt: boolean;
  promptInputRef: React.RefObject<HTMLTextAreaElement | null>;
  handlePauseOnly: () => void;
  handleInjectAndResume: () => void;
  handleResumeOnly: () => void;
  tr: TrFn;
}

export function InterventionPanel({
  task,
  interventionPrompt,
  setInterventionPrompt,
  interventionBusy,
  interventionError,
  interventionMessage,
  interruptProof,
  hasAssignedAgent,
  canInjectPrompt,
  canAttemptInterrupt,
  promptInputRef,
  handlePauseOnly,
  handleInjectAndResume,
  handleResumeOnly,
  tr,
}: InterventionPanelProps) {
  return (
    <div className="border-b px-4 py-3 space-y-2" style={{ borderColor: "var(--th-border)" }}>
      <div className="text-[11px]" style={{ color: "var(--th-text-secondary)" }}>
        {task?.status === "in_progress"
          ? tr(
              "실행 중 작업을 보류하고, 새 프롬프트를 주입한 뒤 자동 재개합니다.",
              "Pause the running task, inject a new prompt, then auto-resume.",
              "実行中タスクを保留にし、新しいプロンプトを注入して自動再開します。",
              "将运行中的任务暂停，注入新提示后自动恢复。",
              "Laufende Aufgabe pausieren, neuen Prompt einschleusen, dann automatisch fortfahren.",
            )
          : tr(
              "보류 상태에서 프롬프트를 주입하고 재개할 수 있습니다.",
              "Inject a prompt while pending and resume execution.",
              "保留状態でプロンプトを注入し、再開できます。",
              "可在暂停状态下注入提示并恢复执行。",
              "Im Wartezustand einen Prompt einschleusen und Ausführung fortsetzen.",
            )}
      </div>
      <textarea
        ref={promptInputRef}
        value={interventionPrompt}
        onChange={(event) => {
          const next = event.target.value.slice(0, INTERVENTION_PROMPT_MAX_LENGTH);
          setInterventionPrompt(next);
        }}
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !interventionBusy) {
            event.preventDefault();
            void handleInjectAndResume();
          }
        }}
        rows={3}
        disabled={interventionBusy}
        className="w-full rounded-md border px-2 py-1.5 text-xs font-mono resize-y focus:outline-none focus:ring-1 focus:ring-cyan-500/50"
        style={{
          borderColor: "var(--th-border)",
          background: "var(--th-bg-surface)",
          color: "var(--th-text-primary)",
        }}
        placeholder={tr(
          "예) 방금 방식 대신 테스트를 먼저 실행하고 실패 원인을 정리해.",
          "e.g. Run tests first, then summarize failures before continuing.",
          "例) 先にテストを実行し、失敗原因を整理してから続行してください。",
          "例如：先执行测试，再整理失败原因后继续。",
          "z.B. Tests zuerst ausführen, dann Fehlerursachen zusammenfassen.",
        )}
      />
      <div className="flex items-center justify-between text-[10px]" style={{ color: "var(--th-text-muted)" }}>
        <span>{`${interventionPrompt.length} / ${INTERVENTION_PROMPT_MAX_LENGTH}`}</span>
        <span>
          {tr(
            "Ctrl+Enter로 실행",
            "Ctrl+Enter to run",
            "Ctrl+Enterで実行",
            "Ctrl+Enter 执行",
            "Ctrl+Enter zum Ausführen",
          )}
        </span>
      </div>
      {interventionError && <div className="text-[11px] text-rose-300 break-words">{interventionError}</div>}
      {interventionMessage && <div className="text-[11px] text-emerald-300 break-words">{interventionMessage}</div>}
      <div className="flex flex-wrap items-center gap-2">
        {task?.status === "in_progress" && (
          <button
            onClick={() => void handlePauseOnly()}
            disabled={interventionBusy}
            className="rounded-md px-2.5 py-1.5 text-[11px] border transition disabled:opacity-50"
            style={{ borderColor: "var(--th-border)", color: "var(--th-text-secondary)" }}
          >
            {interventionBusy
              ? tr("처리 중...", "Processing...", "処理中...", "处理中...", "Wird verarbeitet...")
              : tr("일시중지", "Pause", "一時停止", "暂停", "Pausieren")}
          </button>
        )}
        <button
          onClick={() => void handleInjectAndResume()}
          disabled={interventionBusy || !interventionPrompt.trim() || !canAttemptInterrupt}
          className="rounded-md px-2.5 py-1.5 text-[11px] border transition disabled:opacity-70 disabled:cursor-not-allowed"
          style={{
            borderColor: "var(--th-danger-border)",
            background: "var(--th-danger-bg)",
            color: "var(--th-danger-text)",
            fontWeight: 600,
          }}
        >
          {interventionBusy
            ? tr("실행 중...", "Running...", "実行中...", "执行中...", "Läuft...")
            : tr("난입 실행", "Inject + Resume", "割込実行", "中断注入", "Einschleusen + Fortfahren")}
        </button>
        {canInjectPrompt && (
          <button
            onClick={() => void handleResumeOnly()}
            disabled={interventionBusy}
            className="rounded-md px-2.5 py-1.5 text-[11px] border transition disabled:opacity-50"
            style={{ borderColor: "var(--th-border)", color: "var(--th-text-secondary)" }}
          >
            {tr("재개만", "Resume only", "再開のみ", "仅恢复", "Nur fortfahren")}
          </button>
        )}
      </div>
      {!interruptProof?.session_id && (
        <div className="text-[10px] text-amber-300">
          {hasAssignedAgent
            ? tr(
                "세션 토큰이 아직 준비되지 않았습니다. 잠시 후 다시 시도해 주세요.",
                "Session token is not ready yet. Please retry shortly.",
                "セッショントークンがまだ準備されていません。しばらくしてから再試行してください。",
                "会话令牌尚未就绪，请稍后重试。",
                "Sitzungstoken noch nicht bereit. Bitte kurz warten und erneut versuchen.",
              )
            : tr(
                "담당 에이전트가 없어 세션 토큰을 만들 수 없습니다. 먼저 에이전트를 배정해 주세요.",
                "No assigned agent, so a session token cannot be created. Assign an agent first.",
                "担当エージェントがいないためセッショントークンを作成できません。先にエージェントを割り当ててください。",
                "未分配代理，无法创建会话令牌。请先分配代理。",
                "Kein Agent zugewiesen – Sitzungstoken kann nicht erstellt werden. Bitte zuerst einen Agenten zuweisen.",
              )}
        </div>
      )}
    </div>
  );
}
