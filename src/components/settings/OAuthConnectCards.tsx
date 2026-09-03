import { CONNECTABLE_PROVIDERS } from "./constants";
import type { OAuthConnectCardProps } from "./types";

export default function OAuthConnectCards({
  t,
  oauthStatus,
  deviceCode,
  deviceStatus,
  deviceError,
  onConnect,
  onStartDeviceCodeFlow,
}: OAuthConnectCardProps) {
  return (
    <div className="space-y-3">
      <div className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--th-text-muted)" }}>
        {t({
          ko: "OAuth 계정 추가",
          en: "Add OAuth Account",
          ja: "OAuth アカウント追加",
          zh: "Add OAuth Account",
          de: "OAuth-Konto hinzufügen",
        })}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {CONNECTABLE_PROVIDERS.map(({ id, label, Logo, description }) => {
          const providerInfo = oauthStatus.providers[id];
          const isConnected = Boolean(providerInfo?.executionReady ?? providerInfo?.connected);
          const isDetectedOnly = Boolean(providerInfo?.detected) && !isConnected;
          const storageOk = oauthStatus.storageReady;
          const isGitHub = id === "github-copilot";

          return (
            <div
              key={id}
              className={`flex flex-col items-center gap-2 p-4 rounded-xl border transition-all ${
                isConnected
                  ? "bg-green-500/5 border-green-500/30"
                  : isDetectedOnly
                    ? "bg-amber-500/5 border-amber-500/30"
                    : storageOk
                      ? "hover:border-blue-400/50"
                      : "opacity-50"
              }`}
              style={
                !isConnected && !isDetectedOnly
                  ? { background: "var(--th-card-bg)", borderColor: "var(--th-border)" }
                  : undefined
              }
            >
              <Logo className="w-8 h-8" />
              <span className="text-sm font-medium" style={{ color: "var(--th-text-heading)" }}>
                {label}
              </span>
              <span className="text-[10px] text-center leading-tight" style={{ color: "var(--th-text-secondary)" }}>
                {description}
              </span>

              {!storageOk ? (
                <span className="text-[10px] px-2 py-0.5 rounded bg-yellow-500/20 text-yellow-500">
                  {t({
                    ko: "암호화 키 필요",
                    en: "Encryption key required",
                    ja: "暗号化キーが必要",
                    zh: "Encryption key required",
                    de: "Verschlüsselungsschlüssel erforderlich",
                  })}
                </span>
              ) : (
                <>
                  {isConnected ? (
                    <span className="text-[11px] px-2.5 py-1 rounded-lg bg-green-500/20 text-green-400 font-medium">
                      {t({ ko: "실행 가능", en: "Runnable", ja: "実行可能", zh: "Runnable", de: "Ausführbar" })}
                    </span>
                  ) : isDetectedOnly ? (
                    <span className="text-[11px] px-2.5 py-1 rounded-lg bg-amber-500/20 text-amber-300 font-medium">
                      {t({ ko: "감지됨", en: "Detected", ja: "検出済み", zh: "Detected", de: "Erkannt" })}
                    </span>
                  ) : null}

                  {isGitHub ? (
                    deviceCode && deviceStatus === "polling" ? (
                      <div className="flex flex-col items-center gap-1.5">
                        <div
                          className="text-xs font-mono px-3 py-1.5 rounded-lg tracking-widest select-all"
                          style={{ color: "var(--th-text-secondary)", background: "var(--th-bg-surface-hover)" }}
                        >
                          {deviceCode.userCode}
                        </div>
                        <span className="text-[10px] text-blue-400 animate-pulse">
                          {t({
                            ko: "코드 입력 대기 중...",
                            en: "Waiting for code...",
                            ja: "コード入力待機中...",
                            zh: "Waiting for code...",
                            de: "Warte auf Code-Eingabe...",
                          })}
                        </span>
                      </div>
                    ) : (
                      <button
                        onClick={() => void onStartDeviceCodeFlow()}
                        className="text-[11px] px-3 py-1 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-medium transition-colors"
                      >
                        {isConnected || isDetectedOnly
                          ? t({
                              ko: "계정 추가",
                              en: "Add Account",
                              ja: "アカウント追加",
                              zh: "Add Account",
                              de: "Konto hinzufügen",
                            })
                          : t({ ko: "연결하기", en: "Connect", ja: "接続", zh: "Connect", de: "Verbinden" })}
                      </button>
                    )
                  ) : (
                    <button
                      onClick={() => onConnect(id)}
                      className="text-[11px] px-3 py-1 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-medium transition-colors"
                    >
                      {isConnected || isDetectedOnly
                        ? t({
                            ko: "계정 추가",
                            en: "Add Account",
                            ja: "アカウント追加",
                            zh: "Add Account",
                            de: "Konto hinzufügen",
                          })
                        : t({ ko: "연결하기", en: "Connect", ja: "接続", zh: "Connect", de: "Verbinden" })}
                    </button>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>

      {deviceStatus === "complete" && (
        <div className="space-y-1.5">
          <div className="text-xs text-green-400 bg-green-500/10 border border-green-500/20 px-3 py-2 rounded-lg">
            {t({
              ko: "GitHub 연결 완료!",
              en: "GitHub connected!",
              ja: "GitHub 接続完了!",
              zh: "GitHub connected!",
              de: "GitHub verbunden!",
            })}
          </div>
          <div
            className="text-[11px] border px-3 py-2 rounded-lg"
            style={{
              color: "var(--th-text-secondary)",
              background: "var(--th-card-bg)",
              borderColor: "var(--th-border)",
            }}
          >
            {t({
              ko: "Copilot 구독이 있으면 AI 모델을 사용할 수 있고, 없어도 프로젝트 관리의 GitHub 리포 가져오기 기능은 정상 작동합니다.",
              en: "With a Copilot subscription you can use AI models. Without it, GitHub repo import in Project Manager still works.",
              ja: "Copilot サブスクリプションがあれば AI モデルを利用できます。なくてもプロジェクト管理の GitHub リポインポートは利用可能です。",
              zh: "With a Copilot subscription you can use AI models. Without it, GitHub repo import in Project Manager still works.",
              de: "Mit einem Copilot-Abonnement können Sie AI-Modelle nutzen. Ohne Abonnement funktioniert der GitHub-Repo-Import im Projektmanager weiterhin.",
            })}
          </div>
        </div>
      )}

      {deviceError && (
        <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 px-3 py-2 rounded-lg">
          {deviceError}
        </div>
      )}
    </div>
  );
}
