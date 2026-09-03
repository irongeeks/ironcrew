export const MESSENGER_CHANNELS = [
  "telegram",
  "whatsapp",
  "discord",
  "googlechat",
  "slack",
  "signal",
  "imessage",
] as const;

export type MessengerChannel = (typeof MESSENGER_CHANNELS)[number];

export const NATIVE_MESSENGER_CHANNELS = [...MESSENGER_CHANNELS] as const;

export function isMessengerChannel(value: unknown): value is MessengerChannel {
  return typeof value === "string" && (MESSENGER_CHANNELS as readonly string[]).includes(value);
}

export function isNativeMessengerChannel(value: unknown): value is (typeof NATIVE_MESSENGER_CHANNELS)[number] {
  return typeof value === "string" && (NATIVE_MESSENGER_CHANNELS as readonly string[]).includes(value);
}
