import { createHash } from "node:crypto";
import { sendMessengerMessage, type MessengerChannel } from "../../../../../gateway/client.ts";
import { isMessengerChannel } from "../../../../../messenger/channels.ts";
import { resolveSourceChatRoute } from "../../../../../messenger/session-agent-routing.ts";
import type { RuntimeContext } from "../../../../../types/runtime-context.ts";
import { createDecisionNoticeFormatter } from "./messenger-notice-format.ts";
import type { DecisionInboxRouteItem } from "./types.ts";
import { logger } from "../../../../../observability/logger.ts";

const log = logger.child({ module: "ops" });

export type DecisionReplyBridgeInput = {
  text: string;
  body?: Record<string, unknown>;
  source?: string | null;
  chat?: string | null;
  channel?: MessengerChannel;
  targetId?: string | null;
};

export type DecisionReplyBridgeResult = {
  handled: boolean;
  status: number;
  payload: Record<string, unknown>;
};

type DecisionRoute = { channel: MessengerChannel; targetId: string };

type DecisionApplyResult = {
  status: number;
  payload: Record<string, unknown>;
};

type DecisionBridgeDeps = {
  db: RuntimeContext["db"];
  nowMs: () => number;
  getPreferredLanguage: RuntimeContext["getPreferredLanguage"];
  normalizeTextField: RuntimeContext["normalizeTextField"];
  getDecisionInboxItems: () => DecisionInboxRouteItem[];
  applyDecisionReply: (decisionId: string, body: Record<string, unknown>) => Promise<DecisionApplyResult>;
};

const TASK_MESSENGER_ROUTE_PREFIX = "[messenger-route]";
const DECISION_NOTICE_CACHE_MAX = 1024;
const DECISION_NOTICE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DECISION_NOTICE_SENT_KEY_PREFIX = "decision_notice_sent:";
const DECISION_REPLY_MARKER_RE = /\[(의사결정\s*회신|decision\s*reply|意思決定返信|决策回复)\]/i;
const DECISION_TOKEN_RE = /\[DECISION:([A-Za-z0-9_-]{6,128})\]/i;
const DECISION_APPROVE_WORD_RE =
  /^(승인|진행|go|ok|okay|yes|yep|approve|approved|확인|동의|承認|進行|はい|同意|通过|批准|好的|可以|行)$/i;
const DECISION_NOTE_RE = /(?:추가\s*(?:코멘트|의견|메모)|note|비고|备注)\s*[:：]\s*(.+)$/i;

export function createDecisionInboxMessengerBridge(deps: DecisionBridgeDeps) {
  const { db, nowMs, getPreferredLanguage, normalizeTextField, getDecisionInboxItems, applyDecisionReply } = deps;
  const { buildDecisionMessengerNotice } = createDecisionNoticeFormatter({
    getPreferredLanguage,
    normalizeTextField,
  });

  const sentDecisionNoticeSignatureById = new Map<string, { signature: string; sentAt: number }>();
  const decisionRouteByDecisionId = new Map<
    string,
    { channel: MessengerChannel; targetId: string; updatedAt: number }
  >();

  function pickDecisionL10n(ko: string, en: string, ja: string, zh: string): string {
    const lang = getPreferredLanguage();
    if (lang === "en") return en;
    if (lang === "ja") return ja;
    if (lang === "zh") return zh;
    return ko;
  }

  function pruneDecisionCaches(now: number, activeDecisionIds?: Set<string>): void {
    for (const [decisionId, sent] of sentDecisionNoticeSignatureById.entries()) {
      if (now - sent.sentAt > DECISION_NOTICE_CACHE_TTL_MS) sentDecisionNoticeSignatureById.delete(decisionId);
    }
    for (const [decisionId, route] of decisionRouteByDecisionId.entries()) {
      if (now - route.updatedAt > DECISION_NOTICE_CACHE_TTL_MS) decisionRouteByDecisionId.delete(decisionId);
    }
    if (activeDecisionIds) {
      for (const decisionId of sentDecisionNoticeSignatureById.keys()) {
        if (!activeDecisionIds.has(decisionId)) sentDecisionNoticeSignatureById.delete(decisionId);
      }
      for (const decisionId of decisionRouteByDecisionId.keys()) {
        if (!activeDecisionIds.has(decisionId)) decisionRouteByDecisionId.delete(decisionId);
      }
    }
    while (sentDecisionNoticeSignatureById.size > DECISION_NOTICE_CACHE_MAX) {
      const oldest = sentDecisionNoticeSignatureById.keys().next().value;
      if (!oldest) break;
      sentDecisionNoticeSignatureById.delete(oldest);
    }
    while (decisionRouteByDecisionId.size > DECISION_NOTICE_CACHE_MAX) {
      const oldest = decisionRouteByDecisionId.keys().next().value;
      if (!oldest) break;
      decisionRouteByDecisionId.delete(oldest);
    }
  }

  function parseTaskMessengerRouteLine(line: string): DecisionRoute | null {
    if (!line.startsWith(`${TASK_MESSENGER_ROUTE_PREFIX} `)) return null;
    const payload = line.slice(TASK_MESSENGER_ROUTE_PREFIX.length).trim();
    const separator = payload.indexOf(":");
    if (separator <= 0) return null;
    const channelRaw = payload.slice(0, separator).trim().toLowerCase();
    const targetId = payload.slice(separator + 1).trim();
    if (!isMessengerChannel(channelRaw) || !targetId) return null;
    return { channel: channelRaw, targetId };
  }

  function buildDecisionNoticeSettingKey(decisionId: string, route: DecisionRoute): string {
    return `${DECISION_NOTICE_SENT_KEY_PREFIX}${decisionId}:${route.channel}:${route.targetId}`;
  }

  function buildDecisionNoticeSignature(item: DecisionInboxRouteItem): string {
    const normalizedSummary = String(item.summary || "")
      .replace(/\s+/g, " ")
      .trim();
    const optionBlock = item.options
      .map(
        (option) =>
          `${option.number}:${option.action}:${String(option.label || "")
            .replace(/\s+/g, " ")
            .trim()}`,
      )
      .join("|");
    const raw = [
      item.id,
      item.kind,
      String(item.created_at ?? 0),
      normalizeTextField(item.project_id) ?? "",
      normalizeTextField(item.task_id) ?? "",
      normalizeTextField(item.meeting_id) ?? "",
      String(item.review_round ?? ""),
      normalizedSummary,
      optionBlock,
    ].join("||");
    return createHash("sha1").update(raw).digest("hex");
  }

  function reserveDecisionNoticeSend(
    item: DecisionInboxRouteItem,
    route: DecisionRoute,
  ): { key: string; token: string; signature: string } | "already_sent" | null {
    const key = buildDecisionNoticeSettingKey(item.id, route);
    const signature = buildDecisionNoticeSignature(item);
    const token = `sending:${signature}:${nowMs()}:${Math.random().toString(36).slice(2, 10)}`;
    try {
      const result = db
        .prepare(
          `
          INSERT INTO settings (key, value)
          VALUES (?, ?)
          ON CONFLICT(key) DO NOTHING
        `,
        )
        .run(key, token) as { changes?: number };
      if ((result?.changes ?? 0) > 0) return { key, token, signature };

      const existing = db.prepare("SELECT value FROM settings WHERE key = ? LIMIT 1").get(key) as
        | { value?: unknown }
        | undefined;
      const existingValue = normalizeTextField(existing?.value) ?? "";
      if (existingValue === signature) return "already_sent";
      if (existingValue.startsWith("sending:")) return null;

      const takeover = db
        .prepare("UPDATE settings SET value = ? WHERE key = ? AND value = ?")
        .run(token, key, existingValue) as { changes?: number };
      if ((takeover?.changes ?? 0) > 0) return { key, token, signature };

      const latest = db.prepare("SELECT value FROM settings WHERE key = ? LIMIT 1").get(key) as
        | { value?: unknown }
        | undefined;
      const latestValue = normalizeTextField(latest?.value) ?? "";
      if (latestValue === signature) return "already_sent";
      return null;
    } catch {
      return null;
    }
  }

  function markDecisionNoticeSent(reserved: { key: string; token: string; signature: string }): void {
    const updated = db
      .prepare("UPDATE settings SET value = ? WHERE key = ? AND value = ?")
      .run(reserved.signature, reserved.key, reserved.token) as { changes?: number } | undefined;
    if ((updated?.changes ?? 0) > 0) return;

    const existing = db.prepare("SELECT value FROM settings WHERE key = ? LIMIT 1").get(reserved.key) as
      | { value?: unknown }
      | undefined;
    const currentValue = normalizeTextField(existing?.value) ?? "";
    if (!currentValue || currentValue.startsWith("sending:")) {
      db.prepare("UPDATE settings SET value = ? WHERE key = ?").run(reserved.signature, reserved.key);
    }
  }

  function releaseDecisionNoticeReservation(reserved: { key: string; token: string; signature: string }): void {
    void reserved.signature;
    db.prepare("DELETE FROM settings WHERE key = ? AND value = ?").run(reserved.key, reserved.token);
  }

  function resolveTaskDecisionRoute(taskId: string): DecisionRoute | null {
    const row = db
      .prepare(
        `
        SELECT message
        FROM task_logs
        WHERE task_id = ?
          AND kind = 'system'
          AND message LIKE ?
        ORDER BY created_at DESC
        LIMIT 1
      `,
      )
      .get(taskId, `${TASK_MESSENGER_ROUTE_PREFIX} %`) as { message?: string } | undefined;
    return typeof row?.message === "string" ? parseTaskMessengerRouteLine(row.message) : null;
  }

  function resolveProjectDecisionRoute(projectId: string): DecisionRoute | null {
    const row = db
      .prepare(
        `
        SELECT tl.message
        FROM task_logs tl
        JOIN tasks t ON t.id = tl.task_id
        WHERE t.project_id = ?
          AND tl.kind = 'system'
          AND tl.message LIKE ?
        ORDER BY tl.created_at DESC
        LIMIT 1
      `,
      )
      .get(projectId, `${TASK_MESSENGER_ROUTE_PREFIX} %`) as { message?: string } | undefined;
    return typeof row?.message === "string" ? parseTaskMessengerRouteLine(row.message) : null;
  }

  function resolveDecisionRoute(item: DecisionInboxRouteItem): DecisionRoute | null {
    const now = nowMs();
    const cached = decisionRouteByDecisionId.get(item.id);
    if (cached) return { channel: cached.channel, targetId: cached.targetId };

    const taskId = normalizeTextField(item.task_id);
    const projectId = normalizeTextField(item.project_id);
    const route =
      (taskId ? resolveTaskDecisionRoute(taskId) : null) ??
      (projectId ? resolveProjectDecisionRoute(projectId) : null) ??
      null;
    if (!route) return null;

    decisionRouteByDecisionId.set(item.id, { channel: route.channel, targetId: route.targetId, updatedAt: now });
    pruneDecisionCaches(now);
    return route;
  }

  function parseOptionNumbersFromText(text: string): number[] {
    const sanitized = text.replace(DECISION_TOKEN_RE, " ").replace(DECISION_REPLY_MARKER_RE, " ");
    const numbers: number[] = [];
    for (const match of sanitized.matchAll(/(?:^|[^\d])([1-9]\d?)(?:\s*(?:번|番|号|option))?(?=$|[^\d])/gi)) {
      const raw = match[1];
      if (!raw) continue;
      const num = Number.parseInt(raw, 10);
      if (!Number.isFinite(num)) continue;
      numbers.push(num);
    }
    return Array.from(new Set(numbers));
  }

  function isPlainDecisionChoiceText(text: string): boolean {
    const sanitized = text.replace(DECISION_TOKEN_RE, " ").replace(DECISION_REPLY_MARKER_RE, " ").trim();
    if (!sanitized) return false;
    if (DECISION_APPROVE_WORD_RE.test(sanitized)) return true;
    const tokens = sanitized
      .split(/[\s,，/|]+/)
      .map((token) => token.trim())
      .filter(Boolean);
    if (tokens.length <= 0) return false;
    return tokens.every((token) => /^[1-9]\d?(?:번|option|号|番)?$/i.test(token));
  }

  function extractDecisionNote(text: string, body: Record<string, unknown>): string | null {
    const bodyNote = normalizeTextField(body.note);
    if (bodyNote) return bodyNote;
    const matched = text.match(DECISION_NOTE_RE);
    if (!matched?.[1]) return null;
    const candidate = normalizeTextField(matched[1]);
    return candidate || null;
  }

  function findLatestDecisionForRoute(
    route: DecisionRoute,
    explicitDecisionId?: string | null,
  ): DecisionInboxRouteItem | null {
    const items = getDecisionInboxItems();
    if (explicitDecisionId) {
      const item = items.find((candidate) => candidate.id === explicitDecisionId);
      if (item) return item;
    }
    for (const item of items) {
      const candidateRoute = resolveDecisionRoute(item);
      if (!candidateRoute) continue;
      if (candidateRoute.channel === route.channel && candidateRoute.targetId === route.targetId) {
        return item;
      }
    }
    return null;
  }

  function buildDecisionReplyAck(
    item: DecisionInboxRouteItem,
    optionNumber: number,
    status: number,
    payload: Record<string, unknown>,
  ): string {
    if (status >= 400) {
      const reason = normalizeTextField(payload.error) || `status_${status}`;
      return pickDecisionL10n(
        `⚠️ 의사결정 회신 처리 실패 (${reason})`,
        `⚠️ Decision reply failed (${reason})`,
        `⚠️ 意思決定返信に失敗しました (${reason})`,
        `⚠️ 决策回复失败（${reason}）`,
      );
    }
    if (String(payload.action ?? "") === "start_project_review_blocked") {
      const blockedTasks = Array.isArray(payload.blocked_tasks) ? payload.blocked_tasks : [];
      const firstBlocked = blockedTasks[0] as { title?: unknown; reason?: unknown } | undefined;
      const blockedLabel = String(firstBlocked?.title ?? "").trim() || "task";
      const reasonLabel = String(firstBlocked?.reason ?? "").trim() || "review_gate_hold";
      return pickDecisionL10n(
        `⚠️ 팀장 회의 시작이 보류되었습니다. (${blockedLabel}, ${reasonLabel})`,
        `⚠️ Team-lead meeting start is on hold. (${blockedLabel}, ${reasonLabel})`,
        `⚠️ チームリーダー会議の開始は保留です。(${blockedLabel}, ${reasonLabel})`,
        `⚠️ 组长评审会议暂缓启动。(${blockedLabel}, ${reasonLabel})`,
      );
    }
    const optionLabel =
      item.options.find((option) => option.number === optionNumber)?.label || `option ${optionNumber}`;
    const resolved = payload.resolved === true;
    if (resolved) {
      return pickDecisionL10n(
        `✅ 의사결정 반영 완료: ${optionLabel}`,
        `✅ Decision applied: ${optionLabel}`,
        `✅ 意思決定を反映しました: ${optionLabel}`,
        `✅ 已应用决策：${optionLabel}`,
      );
    }
    return pickDecisionL10n(
      `☑️ 의사결정 기록 완료: ${optionLabel}`,
      `☑️ Decision recorded: ${optionLabel}`,
      `☑️ 意思決定を記録しました: ${optionLabel}`,
      `☑️ 已记录决策：${optionLabel}`,
    );
  }

  async function flushDecisionInboxMessengerNotices(options: { force?: boolean } = {}): Promise<void> {
    const force = options.force === true;
    const items = getDecisionInboxItems();
    const activeIds = new Set(items.map((item) => item.id));
    const now = nowMs();
    pruneDecisionCaches(now, activeIds);
    if (force) sentDecisionNoticeSignatureById.clear();
    for (const item of items.slice().reverse()) {
      if (item.options.length <= 0) continue;
      const signature = buildDecisionNoticeSignature(item);
      const route = resolveDecisionRoute(item);
      if (!route) continue;
      if (!force) {
        const cached = sentDecisionNoticeSignatureById.get(item.id);
        if (cached?.signature === signature) continue;
      } else {
        try {
          const key = buildDecisionNoticeSettingKey(item.id, route);
          db.prepare("DELETE FROM settings WHERE key = ?").run(key);
        } catch {
          // ignore force-reset failures; regular reservation flow will handle concurrency.
        }
      }
      const reserved = reserveDecisionNoticeSend(item, route);
      if (reserved === "already_sent") {
        sentDecisionNoticeSignatureById.set(item.id, { signature, sentAt: nowMs() });
        continue;
      }
      if (!reserved) continue;
      const text = buildDecisionMessengerNotice(item);
      try {
        await sendMessengerMessage({
          channel: route.channel,
          targetId: route.targetId,
          text,
        });
        markDecisionNoticeSent(reserved);
        const t = nowMs();
        sentDecisionNoticeSignatureById.set(item.id, { signature: reserved.signature, sentAt: t });
        decisionRouteByDecisionId.set(item.id, { channel: route.channel, targetId: route.targetId, updatedAt: t });
        pruneDecisionCaches(t);
      } catch (err) {
        releaseDecisionNoticeReservation(reserved);
        log.warn(
          { err, decisionId: item.id, channel: route.channel, targetId: route.targetId },
          "failed to send decision notice",
        );
      }
    }
  }

  async function tryHandleInboxDecisionReply(input: DecisionReplyBridgeInput): Promise<DecisionReplyBridgeResult> {
    const text = String(input.text || "").trim();
    if (!text) return { handled: false, status: 200, payload: {} };

    const body = (input.body ?? {}) as Record<string, unknown>;
    const explicitRoute =
      isMessengerChannel(input.channel) && normalizeTextField(input.targetId)
        ? { channel: input.channel, targetId: normalizeTextField(input.targetId)! }
        : null;
    const fallbackRoute = resolveSourceChatRoute({
      source: normalizeTextField(input.source),
      chat: normalizeTextField(input.chat),
    });
    const route = explicitRoute ?? fallbackRoute;
    if (!route) return { handled: false, status: 200, payload: {} };

    const explicitDecisionId = text.match(DECISION_TOKEN_RE)?.[1] ?? null;
    const hasExplicitMarker = DECISION_REPLY_MARKER_RE.test(text) || Boolean(explicitDecisionId);
    const numbers = parseOptionNumbersFromText(text);
    const hasChoiceLikeText = isPlainDecisionChoiceText(text);
    const isApproveWord = DECISION_APPROVE_WORD_RE.test(text.replace(DECISION_REPLY_MARKER_RE, "").trim());
    const isSimpleChoice = hasChoiceLikeText || (numbers.length === 1 && !hasExplicitMarker) || isApproveWord;
    if (!hasExplicitMarker && !isSimpleChoice) {
      return { handled: false, status: 200, payload: {} };
    }

    const pendingDecision = findLatestDecisionForRoute(route, explicitDecisionId);
    if (!pendingDecision) {
      if (!hasExplicitMarker) return { handled: false, status: 200, payload: {} };
      const noDecisionMsg = pickDecisionL10n(
        "⚠️ 이 채널에는 대기 중인 의사결정 요청이 없습니다.",
        "⚠️ There is no pending decision request on this channel.",
        "⚠️ このチャンネルには保留中の意思決定リクエストがありません。",
        "⚠️ 此频道没有待处理的决策请求。",
      );
      await sendMessengerMessage({ channel: route.channel, targetId: route.targetId, text: noDecisionMsg }).catch(
        () => {
          // no-op
        },
      );
      return { handled: true, status: 404, payload: { error: "decision_not_found_for_route" } };
    }

    const validOptionNumbers = numbers.filter((num) => pendingDecision.options.some((option) => option.number === num));
    let selectedOptionNumber = validOptionNumbers[0];
    if (!selectedOptionNumber && isApproveWord && pendingDecision.options.length > 0) {
      selectedOptionNumber = pendingDecision.options[0]?.number;
    }
    if (!selectedOptionNumber) {
      const optionsHint = pendingDecision.options.map((option) => option.number).join(", ");
      const retryMsg = pickDecisionL10n(
        `⚠️ 선택 번호가 필요합니다. 가능한 번호: ${optionsHint}`,
        `⚠️ Option number required. Available options: ${optionsHint}`,
        `⚠️ 選択番号が必要です。選べる番号: ${optionsHint}`,
        `⚠️ 需要选项编号。可用编号：${optionsHint}`,
      );
      await sendMessengerMessage({ channel: route.channel, targetId: route.targetId, text: retryMsg }).catch(() => {
        // no-op
      });
      return { handled: true, status: 400, payload: { error: "option_number_required" } };
    }

    const note = extractDecisionNote(text, body);
    const replyBody: Record<string, unknown> = {
      ...body,
      option_number: selectedOptionNumber,
    };
    if (pendingDecision.kind === "review_round_pick" && validOptionNumbers.length > 1) {
      replyBody.selected_option_numbers = validOptionNumbers;
    }
    if (note) replyBody.note = note;

    const applied = await applyDecisionReply(pendingDecision.id, replyBody);
    const ack = buildDecisionReplyAck(pendingDecision, selectedOptionNumber, applied.status, applied.payload);
    await sendMessengerMessage({ channel: route.channel, targetId: route.targetId, text: ack }).catch((err) => {
      log.warn(
        { err, decisionId: pendingDecision.id, channel: route.channel, targetId: route.targetId },
        "failed to send decision reply ack",
      );
    });

    return {
      handled: true,
      status: applied.status,
      payload: {
        ...applied.payload,
        decision_id: pendingDecision.id,
        option_number: selectedOptionNumber,
      },
    };
  }

  function startBackgroundNoticeSync(): void {
    const decisionNoticeTimer = setInterval(() => {
      void flushDecisionInboxMessengerNotices().catch((err) => {
        log.warn({ err }, "background notice flush failed");
      });
    }, 5000);
    (decisionNoticeTimer as NodeJS.Timeout).unref?.();
    setTimeout(() => {
      void flushDecisionInboxMessengerNotices().catch((err) => {
        log.warn({ err }, "initial notice flush failed");
      });
    }, 1200);
  }

  return {
    tryHandleInboxDecisionReply,
    flushDecisionInboxMessengerNotices,
    startBackgroundNoticeSync,
  };
}
