import type { DatabaseSync } from "node:sqlite";
import { MESSENGER_CHANNELS, isMessengerChannel, type MessengerChannel } from "./channels.ts";
import { buildMessengerTokenKey } from "./token-hint.ts";
import { decryptMessengerTokenForRuntime } from "./token-crypto.ts";
import { isWorkflowPackKey, type WorkflowPackKey } from "../modules/workflow/packs/definitions.ts";

const MESSENGER_SETTINGS_KEY = "messengerChannels";

type PersistedSession = {
  id?: unknown;
  name?: unknown;
  targetId?: unknown;
  enabled?: unknown;
  token?: unknown;
  agentId?: unknown;
  workflowPackKey?: unknown;
};

type PersistedChannel = {
  token?: unknown;
  sessions?: unknown;
};

type PersistedMessengerChannels = Partial<Record<MessengerChannel, PersistedChannel>>;

export type SessionAgentRoute = {
  channel: MessengerChannel;
  sessionId: string;
  sessionName: string;
  targetId: string;
  agentId: string;
};

export type SessionTargetRoute = {
  channel: MessengerChannel;
  sessionId: string;
  sessionName: string;
  targetId: string;
  agentId?: string;
  workflowPackKey?: WorkflowPackKey;
};

export type AgentSessionRoute = {
  channel: MessengerChannel;
  sessionId: string;
  sessionName: string;
  targetId: string;
};

export type SourceChatRoute = {
  channel: MessengerChannel;
  targetId: string;
};

type ParsedSource = {
  channel: MessengerChannel;
  tokenKey: string | null;
};

function normalizeWorkflowPackKey(value: unknown): WorkflowPackKey | null {
  const normalized = normalizeText(value);
  return isWorkflowPackKey(normalized) ? normalized : null;
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeSource(value: unknown): ParsedSource | null {
  const raw = normalizeText(value).toLowerCase();
  if (!raw) return null;
  const [rawChannel, ...rawHint] = raw.split("#");
  const sourceTokenKey = rawHint.join("#").trim() || null;
  const aliases: Record<string, MessengerChannel> = {
    google_chat: "googlechat",
    "google-chat": "googlechat",
    gchat: "googlechat",
    i_message: "imessage",
    "i-message": "imessage",
  };
  const normalized = aliases[rawChannel] ?? rawChannel;
  if (isMessengerChannel(normalized)) {
    return {
      channel: normalized,
      tokenKey: sourceTokenKey,
    };
  }
  return null;
}

function stripKnownPrefix(channel: MessengerChannel, value: string): string {
  const lower = value.toLowerCase();
  const prefixes = new Set<string>([`${channel}:`, "channel:", "chat:"]);
  if (channel === "googlechat") {
    prefixes.add("googlechat:");
    prefixes.add("google_chat:");
    prefixes.add("google-chat:");
    prefixes.add("gchat:");
    prefixes.add("space:");
  }
  if (channel === "imessage") {
    prefixes.add("imessage:");
    prefixes.add("i_message:");
    prefixes.add("i-message:");
  }

  for (const prefix of prefixes) {
    if (lower.startsWith(prefix)) {
      return value.slice(prefix.length).trim();
    }
  }
  return value;
}

function normalizeTargetId(channel: MessengerChannel, value: unknown): string {
  const normalized = normalizeText(value);
  if (!normalized) return "";
  return stripKnownPrefix(channel, normalized);
}

function resolveSessionId(
  session: PersistedSession,
  channel: MessengerChannel,
  index: number,
  fallbackSeed: string,
): string {
  const explicit = normalizeText(session.id);
  if (explicit) return explicit;
  const byIndex = `${channel}-${index + 1}`;
  if (byIndex) return byIndex;
  return `${channel}-${fallbackSeed}`;
}

function buildTargetCandidates(channel: MessengerChannel, chat: unknown): Set<string> {
  const raw = normalizeText(chat);
  const candidates = new Set<string>();
  if (!raw) return candidates;

  const stripped = stripKnownPrefix(channel, raw);
  if (stripped) candidates.add(stripped);
  candidates.add(raw);
  return candidates;
}

function isSessionEnabled(value: unknown): boolean {
  return value !== false;
}

export function resolveSourceChatRoute(params: { source: unknown; chat: unknown }): SourceChatRoute | null {
  const source = normalizeSource(params.source);
  if (!source) return null;
  const targetId = normalizeTargetId(source.channel, params.chat);
  if (!targetId) return null;
  return { channel: source.channel, targetId };
}

export function resolveSessionTargetRouteFromSettings(params: {
  settingsValue: unknown;
  source: unknown;
  chat: unknown;
}): SessionTargetRoute | null {
  const { settingsValue, source, chat } = params;
  const parsedSource = normalizeSource(source);
  if (!parsedSource) return null;
  const channel = parsedSource.channel;

  if (!settingsValue || typeof settingsValue !== "object" || Array.isArray(settingsValue)) {
    return null;
  }

  const channels = settingsValue as PersistedMessengerChannels;
  const channelConfig = channels[channel];
  if (!channelConfig || typeof channelConfig !== "object" || !Array.isArray(channelConfig.sessions)) {
    return null;
  }

  const channelToken = decryptMessengerTokenForRuntime(channel, channelConfig.token);

  const candidates = buildTargetCandidates(channel, chat);
  if (candidates.size === 0) return null;

  for (let index = 0; index < channelConfig.sessions.length; index += 1) {
    const rawSession = channelConfig.sessions[index];
    const session = (rawSession ?? {}) as PersistedSession;
    if (!isSessionEnabled(session.enabled)) continue;

    const targetId = normalizeTargetId(channel, session.targetId);
    if (!targetId) continue;
    if (!candidates.has(targetId)) continue;
    if (parsedSource.tokenKey) {
      const sessionToken = decryptMessengerTokenForRuntime(channel, session.token);
      const effectiveToken = sessionToken || channelToken;
      const routeTokenKey = buildMessengerTokenKey(channel, effectiveToken);
      if (!routeTokenKey || routeTokenKey !== parsedSource.tokenKey) continue;
    }

    const sessionId = resolveSessionId(session, channel, index, targetId);
    const sessionName = normalizeText(session.name) || sessionId;
    const agentId = normalizeText(session.agentId) || undefined;
    const workflowPackKey = normalizeWorkflowPackKey(session.workflowPackKey) ?? undefined;
    return {
      channel,
      sessionId,
      sessionName,
      targetId,
      ...(agentId ? { agentId } : {}),
      ...(workflowPackKey ? { workflowPackKey } : {}),
    };
  }

  return null;
}

export function resolveSessionAgentRouteFromSettings(params: {
  settingsValue: unknown;
  source: unknown;
  chat: unknown;
}): SessionAgentRoute | null {
  const route = resolveSessionTargetRouteFromSettings(params);
  if (!route?.agentId) return null;
  return {
    channel: route.channel,
    sessionId: route.sessionId,
    sessionName: route.sessionName,
    targetId: route.targetId,
    agentId: route.agentId,
  };
}

export function resolveAgentSessionRoutesFromSettings(params: {
  settingsValue: unknown;
  agentId: unknown;
}): AgentSessionRoute[] {
  const { settingsValue, agentId } = params;
  const targetAgentId = normalizeText(agentId);
  if (!targetAgentId) return [];
  if (!settingsValue || typeof settingsValue !== "object" || Array.isArray(settingsValue)) {
    return [];
  }

  const channels = settingsValue as PersistedMessengerChannels;
  const routes: AgentSessionRoute[] = [];
  const dedupe = new Set<string>();

  for (const channel of MESSENGER_CHANNELS) {
    const channelConfig = channels[channel];
    if (!channelConfig || typeof channelConfig !== "object" || !Array.isArray(channelConfig.sessions)) {
      continue;
    }
    for (let index = 0; index < channelConfig.sessions.length; index += 1) {
      const rawSession = channelConfig.sessions[index];
      const session = (rawSession ?? {}) as PersistedSession;
      if (!isSessionEnabled(session.enabled)) continue;

      const sessionAgentId = normalizeText(session.agentId);
      if (sessionAgentId !== targetAgentId) continue;

      const targetId = normalizeTargetId(channel, session.targetId);
      if (!targetId) continue;

      const sessionId = resolveSessionId(session, channel, index, targetId);
      const sessionName = normalizeText(session.name) || sessionId;
      const key = `${channel}:${targetId}`;
      if (dedupe.has(key)) continue;
      dedupe.add(key);
      routes.push({
        channel,
        sessionId,
        sessionName,
        targetId,
      });
    }
  }

  return routes;
}

function resolveSessionWorkflowPackFromSettings(params: {
  settingsValue: unknown;
  sessionKey: unknown;
}): WorkflowPackKey | null {
  const normalizedSessionKey = normalizeText(params.sessionKey);
  if (!normalizedSessionKey) return null;
  const [rawChannel, ...rest] = normalizedSessionKey.split(":");
  const sessionId = rest.join(":").trim();
  if (!isMessengerChannel(rawChannel) || !sessionId) return null;
  const channel = rawChannel as MessengerChannel;

  if (!params.settingsValue || typeof params.settingsValue !== "object" || Array.isArray(params.settingsValue)) {
    return null;
  }
  const channels = params.settingsValue as PersistedMessengerChannels;
  const channelConfig = channels[channel];
  if (!channelConfig || typeof channelConfig !== "object" || !Array.isArray(channelConfig.sessions)) {
    return null;
  }
  for (const rawSession of channelConfig.sessions) {
    const session = (rawSession ?? {}) as PersistedSession;
    const candidateSessionId = normalizeText(session.id);
    if (!candidateSessionId || candidateSessionId !== sessionId) continue;
    const packKey = normalizeWorkflowPackKey(session.workflowPackKey);
    if (packKey) return packKey;
    return null;
  }
  return null;
}

export function resolveSessionAgentRouteFromDb(params: {
  db: DatabaseSync;
  source: unknown;
  chat: unknown;
}): SessionAgentRoute | null {
  const { db, source, chat } = params;
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(MESSENGER_SETTINGS_KEY) as
      | { value?: unknown }
      | undefined;
    const raw = normalizeText(row?.value);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    return resolveSessionAgentRouteFromSettings({
      settingsValue: parsed,
      source,
      chat,
    });
  } catch {
    return null;
  }
}

export function resolveSessionTargetRouteFromDb(params: {
  db: DatabaseSync;
  source: unknown;
  chat: unknown;
}): SessionTargetRoute | null {
  const { db, source, chat } = params;
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(MESSENGER_SETTINGS_KEY) as
      | { value?: unknown }
      | undefined;
    const raw = normalizeText(row?.value);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    return resolveSessionTargetRouteFromSettings({
      settingsValue: parsed,
      source,
      chat,
    });
  } catch {
    return null;
  }
}

export function resolveSessionWorkflowPackFromDb(params: {
  db: DatabaseSync;
  sessionKey: unknown;
}): WorkflowPackKey | null {
  const { db, sessionKey } = params;
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(MESSENGER_SETTINGS_KEY) as
      | { value?: unknown }
      | undefined;
    const raw = normalizeText(row?.value);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    return resolveSessionWorkflowPackFromSettings({ settingsValue: parsed, sessionKey });
  } catch {
    return null;
  }
}
