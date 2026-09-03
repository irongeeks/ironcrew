import type { RuntimeContext } from "../../../../../types/runtime-context.ts";
import type { DecisionInboxRouteItem } from "./types.ts";

type NoticeFormatterDeps = {
  getPreferredLanguage: RuntimeContext["getPreferredLanguage"];
  normalizeTextField: RuntimeContext["normalizeTextField"];
};

export function createDecisionNoticeFormatter(deps: NoticeFormatterDeps) {
  const { getPreferredLanguage, normalizeTextField } = deps;

  function pickDecisionL10n(ko: string, en: string, ja: string, zh: string): string {
    const lang = getPreferredLanguage();
    if (lang === "en") return en;
    if (lang === "ja") return ja;
    if (lang === "zh") return zh;
    return ko;
  }

  function truncateLine(value: string, max = 220): string {
    const normalized = value.replace(/\s+/g, " ").trim();
    if (normalized.length <= max) return normalized;
    return `${normalized.slice(0, max - 3).trimEnd()}...`;
  }

  function summarizeDecisionText(value: string, max = 120): string {
    const normalized = value.replace(/\s+/g, " ").trim();
    if (!normalized) return "-";
    const cleaned = normalized
      .replace(/[*`]+/g, "")
      .replace(/^\s*[-•]\s*/g, "")
      .trim();
    return truncateLine(cleaned, max);
  }

  function splitDecisionLabel(raw: string): { title: string; detail: string } {
    const cleaned = summarizeDecisionText(raw, 240);
    const colonMatch = cleaned.match(/^([^:：]{1,48})[:：]\s*(.+)$/);
    if (!colonMatch) {
      return { title: cleaned, detail: "" };
    }
    const title = summarizeDecisionText(colonMatch[1] || "", 48);
    const detail = summarizeDecisionText(colonMatch[2] || "", 220);
    return { title, detail };
  }

  function isSkipOption(option: { action?: string; label?: string }): boolean {
    const source = `${option.label || ""} ${option.action || ""}`;
    return /skip|다음\s*라운드|次のラウンド|下一轮/i.test(source);
  }

  function summarizeDecisionOptionStance(input: string): string {
    const text = summarizeDecisionText(input, 220);
    if (!text || text === "-") return pickDecisionL10n("세부 내용 확인", "Check details", "詳細を確認", "查看详情");
    if (/skip|다음\s*라운드|次のラウンド|下一轮/i.test(text)) {
      return pickDecisionL10n("다음 라운드 진행", "Move to next round", "次ラウンドへ進行", "进入下一轮");
    }
    if (/보류|보완|추가요청|미제출|hold|pending|rework|remediation|补充|保留|整改|保留|保留/i.test(text)) {
      return pickDecisionL10n("보완 후 재검토", "Remediate then review", "補完後に再レビュー", "补充后再评审");
    }
    if (/승인|가능|완료|준비|approve|approved|ready|merge|go\b|통과|通过|承認|可行|可進行/i.test(text)) {
      return pickDecisionL10n(
        "승인/즉시 진행 가능",
        "Approved / ready now",
        "承認済み・即時進行可",
        "已批准/可立即推进",
      );
    }
    const firstClause = text.split(/(?<=[.!?。！？])\s+|[,，;；]\s+/)[0] || text;
    return truncateLine(firstClause, 70);
  }

  function extractSummaryClauses(summary: string, maxClauses = 4): string[] {
    const cleaned = summary
      .replace(/\r/g, "\n")
      .replace(/\t/g, " ")
      .replace(/[•●]/g, "-")
      .split(/\n+/)
      .flatMap((line) => line.split(/(?<=[.!?。！？])\s+/))
      .map((line) => summarizeDecisionText(line, 220))
      .filter((line) => line && line !== "-");
    const deduped: string[] = [];
    const seen = new Set<string>();
    for (const clause of cleaned) {
      const key = clause.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(clause);
      if (deduped.length >= maxClauses) break;
    }
    return deduped;
  }

  function buildPlannerSummaryLines(item: DecisionInboxRouteItem): string[] {
    const lines: string[] = [];
    const summaryClauses = extractSummaryClauses(item.summary || "", 3);
    if (summaryClauses.length > 0) {
      lines.push(truncateLine(summaryClauses[0] || "", 95));
    }

    const nonSkipOptions = item.options.filter((option) => !isSkipOption(option));
    for (const option of nonSkipOptions.slice(0, 3)) {
      const { title, detail } = splitDecisionLabel(option.label || option.action || "-");
      const stance = summarizeDecisionOptionStance(detail || title);
      lines.push(truncateLine(`${title} - ${stance}`, 95));
    }

    if (lines.length < 3) {
      const fallback = pickDecisionL10n(
        `총 ${item.options.length}개 선택지 중 우선순위를 골라 회신하면 즉시 반영됩니다.`,
        `Choose priority option(s) from ${item.options.length} choices to apply immediately.`,
        `${item.options.length}件の選択肢から優先順位を選ぶと即時反映されます。`,
        `从 ${item.options.length} 个选项中选择优先项后将立即生效。`,
      );
      lines.push(truncateLine(fallback, 95));
    }

    return lines.slice(0, 5);
  }

  function parseRecommendedOptionNumbers(summary: string, validOptions: Array<{ number: number }>): number[] {
    const valid = new Set(validOptions.map((option) => option.number));
    const parseNumberList = (raw: string | undefined): number[] => {
      if (!raw) return [];
      const numbers: number[] = [];
      for (const match of raw.matchAll(/[1-9]\d?/g)) {
        const picked = Number.parseInt(match[0] || "", 10);
        if (!Number.isFinite(picked)) continue;
        if (!valid.has(picked)) continue;
        if (!numbers.includes(picked)) numbers.push(picked);
      }
      return numbers;
    };

    const normalized = summarizeDecisionText(summary || "", 1200);
    const preferredForward = normalized.match(
      /(?:추천|권장|우선|preferred|recommend(?:ed|ation)?|suggest(?:ed)?|推奨|建议)[^0-9]{0,24}([1-9]\d?(?:\s*[,/|+·\s]\s*[1-9]\d?){0,5})/i,
    );
    const preferredBackward = normalized.match(
      /([1-9]\d?(?:\s*[,/|+·\s]\s*[1-9]\d?){0,5})\s*(?:번|号|番|option)?\s*(?:추천|권장|우선|preferred|recommend(?:ed|ation)?|suggest(?:ed)?|推奨|建议)/i,
    );
    const preferred = parseNumberList(preferredForward?.[1] || preferredBackward?.[1]);
    if (preferred.length > 0) return preferred;

    const genericOptionMatch = normalized.match(/(?:옵션|option|選択肢|选项)\s*([1-9]\d?)/i);
    const generic = parseNumberList(genericOptionMatch?.[1]);
    if (generic.length > 0) return generic;

    return [];
  }

  function resolvePlanningLeadName(item: DecisionInboxRouteItem): string {
    const lang = getPreferredLanguage();
    if (lang === "en")
      return normalizeTextField(item.agent_name) || normalizeTextField(item.agent_name_ko) || "Planning Lead";
    if (lang === "ja")
      return normalizeTextField(item.agent_name) || normalizeTextField(item.agent_name_ko) || "企画リード";
    if (lang === "zh")
      return normalizeTextField(item.agent_name) || normalizeTextField(item.agent_name_ko) || "企划组长";
    return normalizeTextField(item.agent_name_ko) || normalizeTextField(item.agent_name) || "기획팀장";
  }

  function resolveRecommendedOptions(item: DecisionInboxRouteItem): Array<{ number: number; title: string }> {
    const options = item.options;
    if (options.length <= 0) return [];

    const fromSummaryNumbers = parseRecommendedOptionNumbers(item.summary || "", options);
    if (fromSummaryNumbers.length > 0) {
      return fromSummaryNumbers
        .map((number) => options.find((option) => option.number === number) || null)
        .filter((option): option is (typeof options)[number] => option !== null)
        .map((option) => {
          const { title } = splitDecisionLabel(option.label || option.action || "-");
          return { number: option.number, title: truncateLine(title, 42) };
        });
    }

    const planningLeadFirst =
      options.find((option) => {
        if (isSkipOption(option)) return false;
        const source = `${option.label || ""} ${option.action || ""}`;
        return /기획팀|planning|企画|企划|세이지|sage/i.test(source);
      }) ||
      options.find((option) => !isSkipOption(option)) ||
      options[0] ||
      null;
    const fallback = planningLeadFirst;
    if (!fallback) return [];
    const { title } = splitDecisionLabel(fallback.label || fallback.action || "-");
    return [{ number: fallback.number, title: truncateLine(title, 42) }];
  }

  function buildDecisionOptionPreview(option: { number: number; label: string; action: string }): string {
    const raw = option.label || option.action || "-";
    const { title, detail } = splitDecisionLabel(raw);
    const stance = summarizeDecisionOptionStance(detail || title);
    return `${option.number}. ${truncateLine(`${title}: ${stance}`, 92)}`;
  }

  function buildDecisionMessengerNotice(item: DecisionInboxRouteItem): string {
    const projectLabel =
      normalizeTextField(item.project_name) ||
      normalizeTextField(item.project_path) ||
      normalizeTextField(item.project_id) ||
      "-";
    const taskLabel = normalizeTextField(item.task_title);
    const plannerSummaryLines = buildPlannerSummaryLines(item);
    const recommendedOptions = resolveRecommendedOptions(item);
    const recommendedNumbers = recommendedOptions.map((option) => option.number).join(",");
    const planningLeadName = resolvePlanningLeadName(item);
    const options = item.options.slice(0, 8).map((option) => buildDecisionOptionPreview(option));
    const defaultOption = String(item.options[0]?.number ?? options[0]?.match(/^(\d+)/)?.[1] ?? 1);
    const isMultiPick = item.kind === "review_round_pick";
    const replyGuide =
      options.length > 0
        ? pickDecisionL10n(
            isMultiPick
              ? `회신: 번호를 하나/여러 개 보내주세요 (예: ${defaultOption} 또는 ${defaultOption},3)`
              : `회신: 숫자만 보내주세요 (예: ${defaultOption})`,
            isMultiPick
              ? `Reply: send one or multiple option numbers (e.g., ${defaultOption} or ${defaultOption},3)`
              : `Reply: send only the option number (e.g., ${defaultOption})`,
            isMultiPick
              ? `返信: 選択番号を1つ/複数送ってください（例: ${defaultOption} または ${defaultOption},3）`
              : `返信: 選択番号だけ送ってください（例: ${defaultOption}）`,
            isMultiPick
              ? `回复：可发送单个或多个选项编号（例如：${defaultOption} 或 ${defaultOption},3）`
              : `回复：仅发送选项编号（例如：${defaultOption}）`,
          )
        : pickDecisionL10n(
            "회신: 선택 번호를 보내주세요",
            "Reply with an option number",
            "返信: 選択番号を送ってください",
            "回复：请发送选项编号",
          );
    const lines = [
      `${pickDecisionL10n("의사결정 요청", "Decision Request", "意思決定リクエスト", "决策请求")}`,
      `${pickDecisionL10n("프로젝트", "Project", "プロジェクト", "项目")}: ${projectLabel}`,
      ...(taskLabel
        ? [`${pickDecisionL10n("태스크", "Task", "タスク", "任务")}: ${truncateLine(taskLabel, 140)}`]
        : []),
      `${pickDecisionL10n("기획팀장 요약", "Planning lead summary", "企画リード要約", "企划组长摘要")}:`,
      ...plannerSummaryLines.map((line) => `- ${line}`),
      ...(options.length > 0 ? [pickDecisionL10n("선택지", "Options", "選択肢", "选项") + ":", ...options] : []),
      replyGuide,
      ...(recommendedOptions.length > 0
        ? [
            `${pickDecisionL10n("기획팀장", "Planning lead", "企画リード", "企划组长")} ${planningLeadName}: ${pickDecisionL10n(
              `제 소견은 이렇습니다. (${recommendedNumbers}번 추천)`,
              `My recommendation is this. (Recommend ${recommendedNumbers})`,
              `私の所見はこうです。（${recommendedNumbers}を推奨）`,
              `我的建议如下。（推荐 ${recommendedNumbers}）`,
            )}`,
            `${pickDecisionL10n("추천 선택지", "Recommended options", "推奨選択肢", "推荐选项")}: ${recommendedNumbers}`,
          ]
        : []),
    ];
    return lines.join("\n");
  }

  return {
    buildDecisionMessengerNotice,
  };
}
