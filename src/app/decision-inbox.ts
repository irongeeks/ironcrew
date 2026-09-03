import type { DecisionInboxRouteItem } from "../api";
import { normalizeLanguage, pickLang, type UiLanguage } from "../i18n";
import type { DecisionInboxItem } from "../components/chat/decision-inbox";

function baseWorkflowDecisionItem(item: DecisionInboxRouteItem): Omit<DecisionInboxItem, "options"> {
  return {
    id: item.id,
    kind: item.kind,
    agentId: item.agent_id ?? null,
    agentName:
      item.agent_name ||
      (item.kind === "project_review_ready"
        ? item.project_name || item.project_id || "Planning Lead"
        : item.task_title || item.task_id || "Task"),
    agentNameKo:
      item.agent_name_ko ||
      item.agent_name ||
      (item.kind === "project_review_ready"
        ? item.project_name || item.project_id || "기획팀장"
        : item.task_title || item.task_id || "작업"),
    agentAvatar:
      item.agent_avatar ?? (item.kind === "project_review_ready" || item.kind === "review_round_pick" ? "🧑‍💼" : null),
    requestContent: item.summary,
    createdAt: item.created_at,
    taskId: item.task_id,
    projectId: item.project_id,
    projectName: item.project_name,
    projectPath: item.project_path,
  };
}

function localizedOptionLabel(
  kind: DecisionInboxItem["kind"],
  action: string,
  number: number,
  language: UiLanguage,
): string {
  if (kind === "project_review_ready") {
    if (action === "start_project_review") {
      return pickLang(language, {
        ko: "팀장 회의 진행",
        en: "Start Team-Lead Meeting",
        ja: "チームリーダー会議を進行",
        zh: "Start Team-Lead Meeting",
      });
    }
    if (action === "keep_waiting") {
      return pickLang(language, {
        ko: "대기 유지",
        en: "Keep Waiting",
        ja: "待機維持",
        zh: "Keep Waiting",
      });
    }
    if (action === "add_followup_request") {
      return pickLang(language, {
        ko: "추가요청 입력",
        en: "Add Follow-up Request",
        ja: "追加要請を入力",
        zh: "Add Follow-up Request",
      });
    }
  }
  if (kind === "task_timeout_resume") {
    if (action === "resume_timeout_task") {
      return pickLang(language, {
        ko: "이어서 진행 (재개)",
        en: "Resume Task",
        ja: "続行する",
        zh: "Resume Task",
      });
    }
    if (action === "keep_inbox") {
      return pickLang(language, {
        ko: "Inbox 유지",
        en: "Keep in Inbox",
        ja: "Inboxで保留",
        zh: "Keep in Inbox",
      });
    }
  }
  if (kind === "review_round_pick" && action === "skip_to_next_round") {
    return pickLang(language, {
      ko: "다음 라운드로 SKIP",
      en: "Skip to Next Round",
      ja: "次ラウンドへスキップ",
      zh: "Skip to Next Round",
    });
  }
  return `${number}. ${action}`;
}

export function mapWorkflowDecisionItemsRaw(items: DecisionInboxRouteItem[]): DecisionInboxItem[] {
  return items.map((item) => ({
    ...baseWorkflowDecisionItem(item),
    options: item.options.map((option) => ({
      number: option.number,
      label: option.label ?? option.action,
      action: option.action,
    })),
  }));
}

export function mapWorkflowDecisionItemsLocalized(
  items: DecisionInboxRouteItem[],
  language: string,
): DecisionInboxItem[] {
  const locale = normalizeLanguage(language);
  return items.map((item) => ({
    ...baseWorkflowDecisionItem(item),
    options: item.options.map((option) => ({
      number: option.number,
      label: option.label ?? localizedOptionLabel(item.kind, option.action, option.number, locale),
      action: option.action,
    })),
  }));
}
