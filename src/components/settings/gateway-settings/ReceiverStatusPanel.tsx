import type * as api from "../../../api";
import type { ChannelSettingsTabProps } from "../types";

type ReceiverStatusPanelProps = {
  t: ChannelSettingsTabProps["t"];
  telegramReceiverStatus: Awaited<ReturnType<typeof api.getTelegramReceiverStatus>> | null;
  discordReceiverStatus: Awaited<ReturnType<typeof api.getDiscordReceiverStatus>> | null;
};

export default function ReceiverStatusPanel({
  t,
  telegramReceiverStatus,
  discordReceiverStatus,
}: ReceiverStatusPanelProps) {
  if (!telegramReceiverStatus && !discordReceiverStatus) return null;

  return (
    <>
      {telegramReceiverStatus && (
        <div
          className="rounded-md border px-3 py-2 text-xs space-y-1"
          style={{
            borderColor: "var(--th-border)",
            background: "var(--th-card-bg)",
            color: "var(--th-text-secondary)",
          }}
        >
          <div>
            {t({
              ko: "텔레그램 수신기",
              en: "Telegram Receiver",
              ja: "Telegram 受信機",
              zh: "Telegram Receiver",
              de: "Telegram-Empfänger",
            })}
            :{" "}
            <span className={telegramReceiverStatus.enabled ? "text-emerald-400" : "text-amber-300"}>
              {telegramReceiverStatus.enabled
                ? t({ ko: "활성", en: "active", ja: "有効", zh: "active", de: "aktiv" })
                : t({ ko: "비활성", en: "inactive", ja: "無効", zh: "inactive", de: "inaktiv" })}
            </span>
          </div>
          <div>
            {t({
              ko: "허용 chat 수",
              en: "Allowed chats",
              ja: "許可チャット数",
              zh: "Allowed chats",
              de: "Erlaubte Chats",
            })}
            : {telegramReceiverStatus.allowedChatCount}
          </div>
          {telegramReceiverStatus.lastError && <div className="text-red-400">{telegramReceiverStatus.lastError}</div>}
        </div>
      )}

      {discordReceiverStatus && (
        <div
          className="rounded-md border px-3 py-2 text-xs space-y-1"
          style={{
            borderColor: "var(--th-border)",
            background: "var(--th-card-bg)",
            color: "var(--th-text-secondary)",
          }}
        >
          <div>
            {t({
              ko: "디스코드 수신기",
              en: "Discord Receiver",
              ja: "Discord 受信機",
              zh: "Discord Receiver",
              de: "Discord-Empfänger",
            })}
            :{" "}
            <span className={discordReceiverStatus.enabled ? "text-emerald-400" : "text-amber-300"}>
              {discordReceiverStatus.enabled
                ? t({ ko: "활성", en: "active", ja: "有効", zh: "active", de: "aktiv" })
                : t({ ko: "비활성", en: "inactive", ja: "無効", zh: "inactive", de: "inaktiv" })}
            </span>
          </div>
          <div>
            {t({
              ko: "폴링 채널 수",
              en: "Polled channels",
              ja: "ポーリングチャネル数",
              zh: "Polled channels",
              de: "Abgefragte Kanäle",
            })}
            : {discordReceiverStatus.routeCount}
          </div>
          {discordReceiverStatus.lastError && <div className="text-red-400">{discordReceiverStatus.lastError}</div>}
        </div>
      )}
    </>
  );
}
