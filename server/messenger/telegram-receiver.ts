import type { DatabaseSync } from "node:sqlite";
import { INBOX_WEBHOOK_SECRET, OAUTH_BASE_HOST, PORT } from "../config/runtime.ts";
import { buildMessengerSourceWithTokenHint, buildMessengerTokenKey } from "./token-hint.ts";
import { decryptMessengerTokenForRuntime } from "./token-crypto.ts";
import { logger } from "../observability/logger.ts";

const log = logger.child({ module: "messenger" });

const MESSENGER_SETTINGS_KEY = "messengerChannels";
const TELEGRAM_RECEIVER_OFFSET_KEY = "telegramReceiverOffset";
const TELEGRAM_ACTIVE_DELAY_MS = 1_500;
const TELEGRAM_IDLE_DELAY_MS = 5_000;
const TELEGRAM_POLL_TIMEOUT_SECONDS = 20;
const TELEGRAM_CONFLICT_BACKOFF_MS = 90_000;

type PersistedSession = {
  targetId?: unknown;
  enabled?: unknown;
  token?: unknown;
};

type PersistedTelegramChannel = {
  token?: unknown;
  sessions?: unknown;
  receiveEnabled?: unknown;
};

type PersistedMessengerChannels = {
  telegram?: PersistedTelegramChannel;
};

type TelegramUpdateMessage = {
  message_id?: number;
  text?: string;
  caption?: string;
  chat?: {
    id?: number | string;
    title?: string;
  };
  from?: {
    id?: number;
    is_bot?: boolean;
    username?: string;
    first_name?: string;
    last_name?: string;
  };
};

type TelegramUpdate = {
  update_id?: number;
  message?: TelegramUpdateMessage;
  channel_post?: TelegramUpdateMessage;
};

type TelegramGetUpdatesResponse = {
  ok?: boolean;
  description?: string;
  result?: TelegramUpdate[];
};

type TelegramTokenRoute = {
  token: string;
  tokenKey: string;
  source: string;
  allowedChatIds: Set<string>;
};

type TelegramReceiverConfig = {
  receiveEnabled: boolean;
  hasToken: boolean;
  hasSession: boolean;
  routes: TelegramTokenRoute[];
  allowedChatCount: number;
};

export type TelegramReceiverStatus = {
  running: boolean;
  configured: boolean;
  receiveEnabled: boolean;
  enabled: boolean;
  allowedChatCount: number;
  nextOffset: number;
  lastPollAt: number | null;
  lastForwardAt: number | null;
  lastUpdateId: number | null;
  lastError: string | null;
};

export type StartTelegramReceiverOptions = {
  db: DatabaseSync;
  fetchImpl?: typeof fetch;
};

type ReceiverHandle = {
  stop: () => void;
  getStatus: () => TelegramReceiverStatus;
};

const initialStatus = (): TelegramReceiverStatus => ({
  running: false,
  configured: false,
  receiveEnabled: true,
  enabled: false,
  allowedChatCount: 0,
  nextOffset: 0,
  lastPollAt: null,
  lastForwardAt: null,
  lastUpdateId: null,
  lastError: null,
});

let receiverHandle: ReceiverHandle | null = null;
const runtimeOffsetByStatus = new WeakMap<TelegramReceiverStatus, Map<string, number>>();

function cloneStatus(status: TelegramReceiverStatus): TelegramReceiverStatus {
  return { ...status };
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeChatId(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  return normalizeText(value);
}

function readMessengerChannels(db: DatabaseSync): PersistedMessengerChannels | null {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(MESSENGER_SETTINGS_KEY) as
      | { value?: unknown }
      | undefined;
    const raw = normalizeText(row?.value);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as PersistedMessengerChannels;
  } catch {
    return null;
  }
}

function resolveTelegramConfig(db: DatabaseSync): TelegramReceiverConfig {
  let channelToken = "";
  let receiveEnabled = true;
  let hasSession = false;
  const tokenToChatIds = new Map<string, Set<string>>();

  const messengerChannels = readMessengerChannels(db);
  const telegram = messengerChannels?.telegram;
  if (!telegram || typeof telegram !== "object") {
    return {
      receiveEnabled,
      hasToken: false,
      hasSession: false,
      routes: [],
      allowedChatCount: 0,
    };
  }

  if (Object.prototype.hasOwnProperty.call(telegram, "token")) {
    channelToken = decryptMessengerTokenForRuntime("telegram", telegram.token);
  }

  if (typeof telegram.receiveEnabled === "boolean") {
    receiveEnabled = telegram.receiveEnabled;
  }

  if (Object.prototype.hasOwnProperty.call(telegram, "sessions") && Array.isArray(telegram.sessions)) {
    for (const rawSession of telegram.sessions) {
      const session = (rawSession ?? {}) as PersistedSession;
      if (session.enabled === false) continue;
      const chatId = normalizeChatId(session.targetId);
      if (!chatId) continue;
      hasSession = true;
      const sessionToken = decryptMessengerTokenForRuntime("telegram", session.token);
      const effectiveToken = sessionToken || channelToken;
      if (!effectiveToken) continue;
      const chats = tokenToChatIds.get(effectiveToken) ?? new Set<string>();
      chats.add(chatId);
      tokenToChatIds.set(effectiveToken, chats);
    }
  }

  const tokens = [...tokenToChatIds.keys()];
  const includeSourceHint = tokens.length > 1;
  const routes: TelegramTokenRoute[] = tokens.map((token) => {
    const tokenKey = buildMessengerTokenKey("telegram", token);
    return {
      token,
      tokenKey,
      source: includeSourceHint ? buildMessengerSourceWithTokenHint("telegram", tokenKey) : "telegram",
      allowedChatIds: tokenToChatIds.get(token) ?? new Set<string>(),
    };
  });

  const allowedChatCount = routes.reduce((acc, route) => acc + route.allowedChatIds.size, 0);
  return {
    receiveEnabled,
    hasToken: Boolean(channelToken) || tokens.length > 0,
    hasSession,
    routes,
    allowedChatCount,
  };
}

type TelegramReceiverOffsets = {
  legacy: number;
  byToken: Record<string, number>;
};

function normalizeOffset(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value);
  }
  if (typeof value === "string") {
    const numeric = Number(value.trim());
    if (Number.isFinite(numeric) && numeric >= 0) {
      return Math.trunc(numeric);
    }
  }
  return 0;
}

function readReceiverOffsets(db: DatabaseSync): TelegramReceiverOffsets {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(TELEGRAM_RECEIVER_OFFSET_KEY) as
      | { value?: unknown }
      | undefined;
    const raw = normalizeText(row?.value);
    if (!raw) return { legacy: 0, byToken: {} };

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      parsed = raw;
    }

    if (typeof parsed === "number") {
      return { legacy: normalizeOffset(parsed), byToken: {} };
    }
    if (typeof parsed === "string") {
      return { legacy: normalizeOffset(parsed), byToken: {} };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { legacy: 0, byToken: {} };
    }

    const record = parsed as Record<string, unknown>;
    const legacy = normalizeOffset(record.legacy);
    const byToken: Record<string, number> = {};
    const rawByToken = record.byToken;
    if (rawByToken && typeof rawByToken === "object" && !Array.isArray(rawByToken)) {
      for (const [key, value] of Object.entries(rawByToken as Record<string, unknown>)) {
        const normalized = normalizeOffset(value);
        if (normalized >= 0) {
          byToken[key] = normalized;
        }
      }
    }
    return { legacy, byToken };
  } catch {
    return { legacy: 0, byToken: {} };
  }
}

function writeReceiverOffsets(db: DatabaseSync, offsets: TelegramReceiverOffsets): void {
  const legacy = normalizeOffset(offsets.legacy);
  const byToken: Record<string, number> = {};
  for (const [key, value] of Object.entries(offsets.byToken)) {
    byToken[key] = normalizeOffset(value);
  }
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(TELEGRAM_RECEIVER_OFFSET_KEY, JSON.stringify({ legacy, byToken }));
}

function extractMessage(update: TelegramUpdate): TelegramUpdateMessage | null {
  if (update.message && typeof update.message === "object") return update.message;
  if (update.channel_post && typeof update.channel_post === "object") return update.channel_post;
  return null;
}

function buildAuthor(message: TelegramUpdateMessage): string {
  const from = message.from;
  if (!from || typeof from !== "object") {
    return "telegram";
  }
  const username = normalizeText(from.username);
  const firstName = normalizeText(from.first_name);
  const lastName = normalizeText(from.last_name);
  const display = [firstName, lastName].filter(Boolean).join(" ").trim() || username || String(from.id ?? "telegram");
  return username ? `${display}(@${username})` : display;
}

function isTelegramConflictError(message: string): boolean {
  const normalized = normalizeText(message).toLowerCase();
  if (!normalized) return false;
  return (
    normalized.includes("terminated by other getupdates request") ||
    normalized.includes("conflict") ||
    normalized.includes("409")
  );
}

async function forwardTelegramUpdate(params: {
  update: TelegramUpdate;
  source: string;
  allowedChatIds: Set<string>;
  fetchImpl: typeof fetch;
}): Promise<"forwarded" | "skipped"> {
  const { update, source, allowedChatIds, fetchImpl } = params;
  const message = extractMessage(update);
  if (!message) return "skipped";

  if (message.from?.is_bot) {
    return "skipped";
  }

  const chatId = normalizeChatId(message.chat?.id);
  if (!chatId || !allowedChatIds.has(chatId)) {
    return "skipped";
  }

  const text = normalizeText(message.text) || normalizeText(message.caption);
  if (!text) {
    return "skipped";
  }

  const messageId =
    typeof message.message_id === "number" && Number.isFinite(message.message_id)
      ? String(Math.trunc(message.message_id))
      : String(update.update_id ?? `${Date.now()}`);
  const author = buildAuthor(message);
  const inboxRes = await fetchImpl(`http://${OAUTH_BASE_HOST}:${PORT}/api/inbox`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-inbox-secret": INBOX_WEBHOOK_SECRET,
    },
    body: JSON.stringify({
      source,
      message_id: messageId,
      author,
      chat: `telegram:${chatId}`,
      text,
    }),
  });

  if (!inboxRes.ok) {
    const detail = await inboxRes.text().catch(() => "");
    throw new Error(`inbox forward failed (${inboxRes.status})${detail ? `: ${detail}` : ""}`);
  }

  return "forwarded";
}

export async function pollTelegramReceiverOnce(options: {
  db: DatabaseSync;
  status: TelegramReceiverStatus;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const { db, status } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const pollStartedAt = Date.now();
  status.lastPollAt = pollStartedAt;

  const config = resolveTelegramConfig(db);
  status.receiveEnabled = config.receiveEnabled;
  status.allowedChatCount = config.allowedChatCount;
  status.configured = config.routes.length > 0;
  status.enabled = false;

  if (!config.receiveEnabled) {
    status.lastError = null;
    return;
  }
  if (!config.hasToken) {
    status.lastError = "telegram token missing";
    return;
  }
  if (!config.hasSession || config.routes.length === 0) {
    status.lastError = "telegram sessions missing";
    return;
  }
  if (!INBOX_WEBHOOK_SECRET) {
    status.lastError = "INBOX_WEBHOOK_SECRET missing";
    return;
  }

  status.enabled = true;
  const persistedOffsets = readReceiverOffsets(db);
  const inMemoryOffsets = runtimeOffsetByStatus.get(status) ?? new Map<string, number>();
  runtimeOffsetByStatus.set(status, inMemoryOffsets);
  const hasPerTokenOffset = Object.keys(persistedOffsets.byToken).length > 0;
  let highestOffset = 0;
  let highestUpdateId: number | null = status.lastUpdateId;
  let forwardedAny = false;
  let offsetsChanged = false;

  for (const route of config.routes) {
    const persistedOffset = hasPerTokenOffset
      ? (persistedOffsets.byToken[route.tokenKey] ?? 0)
      : persistedOffsets.legacy;
    const inMemoryOffset = inMemoryOffsets.get(route.tokenKey) ?? 0;
    const nextOffset = Math.max(persistedOffset, inMemoryOffset);

    const telegramRes = await fetchImpl(`https://api.telegram.org/bot${route.token}/getUpdates`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        offset: nextOffset,
        timeout: TELEGRAM_POLL_TIMEOUT_SECONDS,
        allowed_updates: ["message", "channel_post"],
      }),
    });

    const payload = (await telegramRes.json().catch(() => null)) as TelegramGetUpdatesResponse | null;
    if (!telegramRes.ok || payload?.ok === false) {
      throw new Error(payload?.description || `telegram getUpdates failed (${telegramRes.status})`);
    }

    const updates = Array.isArray(payload?.result) ? payload.result : [];
    let maxUpdateId = nextOffset - 1;

    for (const update of updates) {
      const updateId =
        typeof update.update_id === "number" && Number.isFinite(update.update_id) ? Math.trunc(update.update_id) : null;
      if (updateId === null) continue;
      if (updateId < nextOffset) continue;

      const result = await forwardTelegramUpdate({
        update,
        source: route.source,
        allowedChatIds: route.allowedChatIds,
        fetchImpl,
      });
      if (result === "forwarded") {
        forwardedAny = true;
      }
      if (updateId > maxUpdateId) {
        maxUpdateId = updateId;
      }
      if (highestUpdateId === null || updateId > highestUpdateId) {
        highestUpdateId = updateId;
      }
    }

    let updatedOffset = nextOffset;
    if (maxUpdateId >= nextOffset) {
      updatedOffset = maxUpdateId + 1;
      offsetsChanged = true;
    }
    inMemoryOffsets.set(route.tokenKey, updatedOffset);
    persistedOffsets.byToken[route.tokenKey] = updatedOffset;
    if (updatedOffset > highestOffset) {
      highestOffset = updatedOffset;
    }
  }

  if (offsetsChanged) {
    persistedOffsets.legacy = highestOffset;
    writeReceiverOffsets(db, persistedOffsets);
  }
  status.nextOffset = highestOffset;
  status.lastUpdateId = highestUpdateId;

  if (forwardedAny) {
    status.lastForwardAt = Date.now();
  }
  status.lastError = null;
}

export function startTelegramReceiver(options: StartTelegramReceiverOptions): ReceiverHandle {
  if (receiverHandle) {
    return receiverHandle;
  }

  const { db } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const status = initialStatus();
  status.running = true;

  let stopped = false;
  let busy = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let conflictPauseUntil = 0;
  let conflictWarnedInPause = false;

  const schedule = (delayMs: number) => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(
      () => {
        void tick();
      },
      Math.max(250, delayMs),
    );
    timer.unref?.();
  };

  const tick = async () => {
    if (stopped || busy) return;
    const now = Date.now();
    if (conflictPauseUntil > 0 && now < conflictPauseUntil) {
      status.enabled = false;
      schedule(Math.min(TELEGRAM_IDLE_DELAY_MS, Math.max(500, conflictPauseUntil - now)));
      return;
    }
    if (conflictPauseUntil > 0 && now >= conflictPauseUntil) {
      conflictPauseUntil = 0;
      conflictWarnedInPause = false;
    }
    busy = true;
    try {
      await pollTelegramReceiverOnce({ db, status, fetchImpl });
      conflictWarnedInPause = false;
    } catch (err) {
      status.lastError = err instanceof Error ? err.message : String(err);
      if (isTelegramConflictError(status.lastError)) {
        conflictPauseUntil = Date.now() + TELEGRAM_CONFLICT_BACKOFF_MS;
        status.enabled = false;
        if (!conflictWarnedInPause) {
          log.warn({ lastError: status.lastError }, "telegram receiver paused");
          log.warn(
            { retryInSec: Math.round(TELEGRAM_CONFLICT_BACKOFF_MS / 1000) },
            "telegram receiver hint: another bot instance is polling this token",
          );
          conflictWarnedInPause = true;
        }
      } else {
        conflictWarnedInPause = false;
        log.warn({ lastError: status.lastError }, "telegram receiver error");
      }
    } finally {
      busy = false;
      schedule(status.enabled ? TELEGRAM_ACTIVE_DELAY_MS : TELEGRAM_IDLE_DELAY_MS);
    }
  };

  schedule(1_200);

  receiverHandle = {
    stop() {
      stopped = true;
      status.running = false;
      status.enabled = false;
      runtimeOffsetByStatus.delete(status);
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      receiverHandle = null;
    },
    getStatus() {
      return cloneStatus(status);
    },
  };

  return receiverHandle;
}

export function getTelegramReceiverStatus(): TelegramReceiverStatus {
  if (!receiverHandle) {
    return initialStatus();
  }
  return receiverHandle.getStatus();
}
