import { createHash } from "node:crypto";
import type { MessengerChannel } from "./channels.ts";

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function buildMessengerTokenKey(channel: MessengerChannel, token: unknown): string {
  const normalized = normalizeText(token);
  if (!normalized) return "";
  const digest = createHash("sha256").update(`${channel}:${normalized}`).digest("hex");
  return digest.slice(0, 16);
}

export function buildMessengerSourceWithTokenHint(channel: MessengerChannel, tokenKey: string): string {
  const normalizedKey = normalizeText(tokenKey).toLowerCase();
  if (!normalizedKey) return channel;
  return `${channel}#${normalizedKey}`;
}
