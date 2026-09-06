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
            {t({ en: "Telegram Receiver", de: "Telegram-Empfänger" })}:{" "}
            <span className={telegramReceiverStatus.enabled ? "text-emerald-400" : "text-amber-300"}>
              {telegramReceiverStatus.enabled ? t({ en: "active", de: "aktiv" }) : t({ en: "inactive", de: "inaktiv" })}
            </span>
          </div>
          <div>
            {t({ en: "Allowed chats", de: "Erlaubte Chats" })}: {telegramReceiverStatus.allowedChatCount}
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
            {t({ en: "Discord Receiver", de: "Discord-Empfänger" })}:{" "}
            <span className={discordReceiverStatus.enabled ? "text-emerald-400" : "text-amber-300"}>
              {discordReceiverStatus.enabled ? t({ en: "active", de: "aktiv" }) : t({ en: "inactive", de: "inaktiv" })}
            </span>
          </div>
          <div>
            {t({ en: "Polled channels", de: "Abgefragte Kanäle" })}: {discordReceiverStatus.routeCount}
          </div>
          {discordReceiverStatus.lastError && <div className="text-red-400">{discordReceiverStatus.lastError}</div>}
        </div>
      )}
    </>
  );
}
