import type { ChannelRuntimeSession, ChannelSettingsTabProps } from "../types";

type RuntimeSessionsPanelProps = {
  t: ChannelSettingsTabProps["t"];
  runtimeSessions: ChannelRuntimeSession[];
};

export default function RuntimeSessionsPanel({ t, runtimeSessions }: RuntimeSessionsPanelProps) {
  if (runtimeSessions.length === 0) return null;

  return (
    <div className="pt-1">
      <div className="text-xs mb-1" style={{ color: "var(--th-text-secondary)" }}>
        {t({
          ko: "런타임 세션",
          en: "Runtime Sessions",
          ja: "実行中セッション",
          zh: "Runtime Sessions",
          de: "Laufzeitsitzungen",
        })}
      </div>
      <div className="max-h-44 overflow-auto rounded-md border" style={{ borderColor: "var(--th-border)" }}>
        {runtimeSessions.map((session) => (
          <div
            key={session.sessionKey}
            className="px-2.5 py-2 text-[11px] border-b last:border-b-0"
            style={{ borderColor: "var(--th-border)", color: "var(--th-text-secondary)" }}
          >
            <span className="font-semibold">{session.channel}</span> · {session.displayName} · {session.targetId}
          </div>
        ))}
      </div>
    </div>
  );
}
