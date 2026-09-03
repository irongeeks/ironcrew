import type { MessengerChannelType, WorkflowPackKey } from "../../../types";

export const CHANNEL_META: Record<
  MessengerChannelType,
  {
    label: string;
    targetHint: string;
    transportReady: boolean;
  }
> = {
  telegram: { label: "Telegram", targetHint: "chat_id", transportReady: true },
  whatsapp: {
    label: "WhatsApp",
    targetHint: "phone_number_id:recipient (예: 1234567890:+8210...)",
    transportReady: true,
  },
  discord: { label: "Discord", targetHint: "channel_id", transportReady: true },
  googlechat: {
    label: "Google Chat",
    targetHint: "spaces/AAA... (token은 webhook URL 또는 key|token)",
    transportReady: true,
  },
  slack: { label: "Slack", targetHint: "channel_id", transportReady: true },
  signal: { label: "Signal", targetHint: "+8210..., group:<id>, username:<id>", transportReady: true },
  imessage: { label: "iMessage", targetHint: "전화번호/이메일 (macOS Messages)", transportReady: true },
};

export function isWorkflowPackKey(value: unknown): value is WorkflowPackKey {
  return typeof value === "string" && /^[a-z_]+$/.test(value) && value.length > 0 && value.length <= 64;
}

export function channelTargetHint(channel: MessengerChannelType): string {
  return CHANNEL_META[channel].targetHint;
}
