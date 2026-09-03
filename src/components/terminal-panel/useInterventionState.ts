import { useState, useEffect, useRef } from "react";
import type { Task } from "../../types";
import { getTerminal, injectTaskPrompt, pauseTask, resumeTask } from "../../api";
import { TERMINAL_TAIL_LINES, TERMINAL_TASK_LOG_LIMIT } from "./model";
import type { InterruptProof } from "./useTerminalData";

type TrFn = (ko: string, en: string, ja?: string, zh?: string, de?: string) => string;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function useInterventionState(
  taskId: string,
  task: Task | undefined,
  fetchTerminal: () => Promise<void>,
  tr: TrFn,
) {
  const [interventionOpen, setInterventionOpen] = useState(false);
  const [interventionPrompt, setInterventionPrompt] = useState("");
  const [interventionBusy, setInterventionBusy] = useState(false);
  const [interventionError, setInterventionError] = useState<string | null>(null);
  const [interventionMessage, setInterventionMessage] = useState<string | null>(null);
  const [interruptProof, setInterruptProof] = useState<InterruptProof | null>(null);
  const promptInputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setInterventionOpen(false);
    setInterventionPrompt("");
    setInterventionBusy(false);
    setInterventionError(null);
    setInterventionMessage(null);
  }, [taskId]);

  useEffect(() => {
    if (!interventionOpen) return;
    setTimeout(() => promptInputRef.current?.focus(), 40);
  }, [interventionOpen]);

  const isInterventionTarget = task?.status === "in_progress" || task?.status === "pending";
  const canInjectPrompt = task?.status === "pending";
  const hasAssignedAgent = Boolean(task?.assigned_agent_id);
  const hasInterruptProof = Boolean(interruptProof?.session_id && interruptProof?.control_token);
  const canAttemptInterrupt = hasAssignedAgent || hasInterruptProof;

  async function fetchInterruptProofNow() {
    const latest = await getTerminal(taskId, TERMINAL_TAIL_LINES, true, TERMINAL_TASK_LOG_LIMIT);
    if (!latest.ok) return null;
    setInterruptProof(latest.interrupt ?? null);
    return latest.interrupt ?? null;
  }

  async function fetchInterruptProofWithRetry(maxAttempts = 4): Promise<InterruptProof | null> {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const proof = await fetchInterruptProofNow();
      if (proof?.session_id && proof.control_token) return proof;
      if (attempt < maxAttempts - 1) {
        await sleep(180 * (attempt + 1));
      }
    }
    return null;
  }

  async function handlePauseOnly() {
    try {
      setInterventionBusy(true);
      setInterventionError(null);
      setInterventionMessage(null);
      const pauseResult = await pauseTask(taskId);
      if (pauseResult.interrupt?.session_id && pauseResult.interrupt.control_token) {
        setInterruptProof(pauseResult.interrupt);
      }
      await fetchTerminal();
      setInterventionMessage(
        tr(
          "작업을 보류 상태로 전환했습니다. 프롬프트를 주입한 뒤 재개해 주세요.",
          "Task paused. Inject a prompt and resume.",
          "タスクを保留にしました。プロンプト注入後に再開してください。",
          "任务已暂停。请注入提示后恢复。",
          "Aufgabe pausiert. Prompt eingeben und fortfahren.",
        ),
      );
    } catch (error) {
      setInterventionError(
        error instanceof Error
          ? error.message
          : tr(
              "일시중지 요청에 실패했습니다.",
              "Pause request failed.",
              "一時停止リクエストに失敗しました。",
              "暂停请求失败。",
              "Pausieranforderung fehlgeschlagen.",
            ),
      );
    } finally {
      setInterventionBusy(false);
    }
  }

  async function handleInjectAndResume() {
    const prompt = interventionPrompt.trim();
    if (!prompt) {
      setInterventionError(
        tr(
          "주입할 프롬프트를 입력해 주세요.",
          "Please enter a prompt to inject.",
          "注入するプロンプトを入力してください。",
          "请输入要注入的提示。",
          "Bitte einen Prompt zum Einschleusen eingeben.",
        ),
      );
      return;
    }

    try {
      setInterventionBusy(true);
      setInterventionError(null);
      setInterventionMessage(null);

      let proof = interruptProof;
      if (task?.status === "in_progress") {
        const pauseResult = await pauseTask(taskId);
        if (pauseResult.interrupt?.session_id && pauseResult.interrupt.control_token) {
          proof = pauseResult.interrupt;
          setInterruptProof(pauseResult.interrupt);
        }
        if (!proof?.session_id || !proof.control_token) {
          proof = await fetchInterruptProofWithRetry(4);
        }
      } else if (task?.status === "pending") {
        const pauseResult = await pauseTask(taskId);
        if (pauseResult.interrupt?.session_id && pauseResult.interrupt.control_token) {
          proof = pauseResult.interrupt;
          setInterruptProof(pauseResult.interrupt);
        }
        if (!proof?.session_id || !proof.control_token) {
          proof = await fetchInterruptProofWithRetry(3);
        }
      }

      if (!proof?.session_id || !proof.control_token) {
        if (!hasAssignedAgent) {
          throw new Error(
            tr(
              "담당 에이전트가 배정되지 않아 난입 세션을 만들 수 없습니다. 먼저 에이전트를 배정해 주세요.",
              "Cannot create an interrupt session because no agent is assigned. Assign an agent first.",
              "担当エージェントが未割り当てのため、割り込みセッションを作成できません。先にエージェントを割り当ててください。",
              "由于未分配执行代理，无法创建中断会话。请先分配代理。",
              "Kein Agent zugewiesen – Unterbrechungssitzung kann nicht erstellt werden. Bitte zuerst einen Agenten zuweisen.",
            ),
          );
        }
        throw new Error(
          tr(
            "난입 세션 토큰이 아직 준비되지 않았습니다. 잠시 후 다시 시도해 주세요.",
            "Interrupt session token is not ready yet. Please retry shortly.",
            "割り込みセッショントークンはまだ準備できていません。しばらくしてから再試行してください。",
            "中断会话令牌尚未就绪，请稍后重试。",
            "Unterbrechungssitzungstoken noch nicht bereit. Bitte kurz warten und erneut versuchen.",
          ),
        );
      }

      await injectTaskPrompt(taskId, {
        session_id: proof.session_id,
        interrupt_token: proof.control_token,
        prompt,
      });
      await resumeTask(taskId);
      setInterventionPrompt("");
      await fetchTerminal();
      setInterventionMessage(
        tr(
          "난입 프롬프트를 주입하고 재개를 요청했습니다.",
          "Prompt injected and resume requested.",
          "プロンプトを注入し、再開をリクエストしました。",
          "已注入提示并请求恢复。",
          "Prompt eingeschleust und Fortsetzung angefordert.",
        ),
      );
    } catch (error) {
      setInterventionError(
        error instanceof Error
          ? error.message
          : tr(
              "난입 실행에 실패했습니다.",
              "Interrupt inject failed.",
              "割り込み注入に失敗しました。",
              "中断注入失败。",
              "Unterbrechungseinschleusung fehlgeschlagen.",
            ),
      );
    } finally {
      setInterventionBusy(false);
    }
  }

  async function handleResumeOnly() {
    try {
      setInterventionBusy(true);
      setInterventionError(null);
      setInterventionMessage(null);
      await resumeTask(taskId);
      await fetchTerminal();
      setInterventionMessage(
        tr(
          "재개 요청을 전송했습니다.",
          "Resume requested.",
          "再開をリクエストしました。",
          "已请求恢复。",
          "Fortsetzung angefordert.",
        ),
      );
    } catch (error) {
      setInterventionError(
        error instanceof Error
          ? error.message
          : tr(
              "재개 요청에 실패했습니다.",
              "Resume request failed.",
              "再開リクエストに失敗しました。",
              "恢复请求失败。",
              "Fortsetzungsanforderung fehlgeschlagen.",
            ),
      );
    } finally {
      setInterventionBusy(false);
    }
  }

  return {
    interventionOpen,
    setInterventionOpen,
    interventionPrompt,
    setInterventionPrompt,
    interventionBusy,
    interventionError,
    setInterventionError,
    interventionMessage,
    setInterventionMessage,
    interruptProof,
    setInterruptProof,
    promptInputRef,
    isInterventionTarget,
    canInjectPrompt,
    hasAssignedAgent,
    hasInterruptProof,
    canAttemptInterrupt,
    handlePauseOnly,
    handleInjectAndResume,
    handleResumeOnly,
  };
}
