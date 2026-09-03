import { decryptSecret, encryptSecret } from "../oauth/helpers.ts";
import { MESSENGER_CHANNELS, type MessengerChannel } from "./channels.ts";

const MESSENGER_TOKEN_ENCRYPTION_PREFIX = "__ce_enc_v1__:";

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function encryptMessengerToken(rawToken: unknown): string {
  const token = normalizeText(rawToken);
  if (!token) return "";
  if (token.startsWith(MESSENGER_TOKEN_ENCRYPTION_PREFIX)) return token;
  return `${MESSENGER_TOKEN_ENCRYPTION_PREFIX}${encryptSecret(token)}`;
}

function decryptMessengerToken(rawToken: unknown, onDecryptError: "raw" | "empty"): string {
  const token = normalizeText(rawToken);
  if (!token) return "";
  if (!token.startsWith(MESSENGER_TOKEN_ENCRYPTION_PREFIX)) return token;
  const payload = token.slice(MESSENGER_TOKEN_ENCRYPTION_PREFIX.length).trim();
  if (!payload) return onDecryptError === "raw" ? token : "";
  try {
    return decryptSecret(payload);
  } catch {
    return onDecryptError === "raw" ? token : "";
  }
}

function mapMessengerChannelsTokens(
  rawChannels: unknown,
  mode: "encrypt" | "decrypt",
  onDecryptError: "raw" | "empty" = "raw",
): unknown {
  if (!isRecord(rawChannels)) return rawChannels;

  const nextChannels: Record<string, unknown> = { ...rawChannels };
  for (const channel of MESSENGER_CHANNELS) {
    const channelConfig = nextChannels[channel];
    if (!isRecord(channelConfig)) continue;

    const nextChannelConfig: Record<string, unknown> = { ...channelConfig };
    if (hasOwn(nextChannelConfig, "token")) {
      nextChannelConfig.token =
        mode === "encrypt"
          ? encryptMessengerToken(nextChannelConfig.token)
          : decryptMessengerToken(nextChannelConfig.token, onDecryptError);
    }
    if (hasOwn(nextChannelConfig, "sessions") && Array.isArray(nextChannelConfig.sessions)) {
      nextChannelConfig.sessions = nextChannelConfig.sessions.map((rawSession) => {
        if (!isRecord(rawSession)) return rawSession;
        if (!hasOwn(rawSession, "token")) return rawSession;
        const nextSession: Record<string, unknown> = { ...rawSession };
        nextSession.token =
          mode === "encrypt"
            ? encryptMessengerToken(nextSession.token)
            : decryptMessengerToken(nextSession.token, onDecryptError);
        return nextSession;
      });
    }
    nextChannels[channel] = nextChannelConfig;
  }

  return nextChannels;
}

export function encryptMessengerChannelsForStorage(rawChannels: unknown): unknown {
  return mapMessengerChannelsTokens(rawChannels, "encrypt");
}

export function decryptMessengerChannelsForClient(rawChannels: unknown): unknown {
  return mapMessengerChannelsTokens(rawChannels, "decrypt", "raw");
}

export function decryptMessengerChannelsForRuntime(rawChannels: unknown): unknown {
  return mapMessengerChannelsTokens(rawChannels, "decrypt", "empty");
}

export function decryptMessengerTokenForRuntime(channel: MessengerChannel, rawToken: unknown): string {
  void channel;
  return decryptMessengerToken(rawToken, "empty");
}
