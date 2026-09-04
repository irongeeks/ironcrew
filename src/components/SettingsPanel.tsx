import { useCallback, useEffect, useRef, useState } from "react";
import { useMobile } from "../hooks/useMobile";
import type { Agent, CliModelInfo, CliStatusMap, CompanySettings } from "../types";
import {
  activateOAuthAccount,
  deleteOAuthAccount,
  disconnectOAuth,
  getCliModels,
  getOAuthModels,
  getOAuthStartUrl,
  getOAuthStatus,
  pollGitHubDevice,
  refreshOAuthToken,
  startGitHubDeviceFlow,
  updateOAuthAccount,
} from "../api";
import type { DeviceCodeStart, OAuthConnectProvider, OAuthStatus } from "../api";
import type { OAuthCallbackResult } from "../App";
import { LANGUAGE_STORAGE_KEY, normalizeLanguage, useI18n } from "../i18n";
import { writeStoredValue } from "../storage";
import ApiSettingsTab from "./settings/ApiSettingsTab";
import CliSettingsTab from "./settings/CliSettingsTab";
import GatewaySettingsTab from "./settings/GatewaySettingsTab";
import GeneralSettingsTab from "./settings/GeneralSettingsTab";
import ComfyUiSettingsTab from "./settings/ComfyUiSettingsTab";
import ConnectorSettingsTab from "./settings/ConnectorSettingsTab";
import McpSettingsTab from "./settings/McpSettingsTab";
import KnowledgeSettingsTab from "./settings/KnowledgeSettingsTab";
import ServersSettingsTab from "./settings/ServersSettingsTab";
import WorkflowPackSettingsTab from "./settings/WorkflowPackSettingsTab";
import ObservabilitySettingsTab from "./settings/ObservabilitySettingsTab";
import OAuthSettingsTab from "./settings/OAuthSettingsTab";
import SettingsTabNav from "./settings/SettingsTabNav";
import type { AccountDraftMap, AccountDraftPatch, LocalSettings, SettingsTab } from "./settings/types";
import { useApiProvidersState } from "./settings/useApiProvidersState";

interface SettingsPanelProps {
  settings: CompanySettings;
  cliStatus: CliStatusMap | null;
  agents?: Agent[];
  onSave: (settings: CompanySettings) => void;
  onRefreshCli: () => void;
  oauthResult?: OAuthCallbackResult | null;
  onOauthResultClear?: () => void;
  initialTab?: SettingsTab;
}

export default function SettingsPanel({
  settings,
  cliStatus,
  agents = [],
  onSave,
  onRefreshCli,
  oauthResult,
  onOauthResultClear,
  initialTab,
}: SettingsPanelProps) {
  const [form, setForm] = useState<LocalSettings>(settings as LocalSettings);
  const { t, locale: localeTag } = useI18n(form.language);
  const [saved, setSaved] = useState(false);
  const [tab, setTab] = useState<SettingsTab>(oauthResult ? "oauth" : (initialTab ?? "general"));
  const { isMobile } = useMobile();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const toggleDrawer = useCallback(() => setDrawerOpen((prev) => !prev), []);

  useEffect(() => {
    if (!isMobile) setDrawerOpen(false);
  }, [isMobile]);

  useEffect(() => {
    if (initialTab) setTab(initialTab);
  }, [initialTab]);

  const [oauthStatus, setOauthStatus] = useState<OAuthStatus | null>(null);
  const [oauthLoading, setOauthLoading] = useState(false);
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState<string | null>(null);
  const [savingAccountId, setSavingAccountId] = useState<string | null>(null);
  const [accountDrafts, setAccountDrafts] = useState<AccountDraftMap>({});

  const [models, setModels] = useState<Record<string, string[]> | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);

  const [cliModels, setCliModels] = useState<Record<string, CliModelInfo[]> | null>(null);
  const [cliModelsLoading, setCliModelsLoading] = useState(false);

  const [deviceCode, setDeviceCode] = useState<DeviceCodeStart | null>(null);
  const [deviceStatus, setDeviceStatus] = useState<string | null>(null);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const persistSettings = useCallback(
    (next: LocalSettings) => {
      onSave(next);
    },
    [onSave],
  );

  const apiState = useApiProvidersState({ tab, t });

  const loadOAuthStatus = useCallback(async () => {
    setOauthLoading(true);
    try {
      const next = await getOAuthStatus();
      setOauthStatus(next);
      setAccountDrafts((prev) => {
        const merged = { ...prev };
        for (const info of Object.values(next.providers)) {
          for (const account of info.accounts ?? []) {
            if (!merged[account.id]) {
              merged[account.id] = {
                label: account.label ?? "",
                modelOverride: account.modelOverride ?? "",
                priority: String(account.priority ?? 100),
              };
            }
          }
        }
        return merged;
      });
    } finally {
      setOauthLoading(false);
    }
  }, []);

  const refreshOAuthTab = useCallback(() => {
    setOauthStatus(null);
    setOauthLoading(true);
    void loadOAuthStatus().catch(console.error);
    setModelsLoading(true);
    getOAuthModels(true)
      .then(setModels)
      .catch(console.error)
      .finally(() => setModelsLoading(false));
  }, [loadOAuthStatus]);

  const refreshCliTab = useCallback(() => {
    onRefreshCli();
    setCliModelsLoading(true);
    getCliModels(true)
      .then(setCliModels)
      .catch(console.error)
      .finally(() => setCliModelsLoading(false));
  }, [onRefreshCli]);

  useEffect(() => {
    setForm(settings as LocalSettings);
    const syncedLocale = normalizeLanguage((settings as LocalSettings).language);
    writeStoredValue(LANGUAGE_STORAGE_KEY, syncedLocale);
    window.dispatchEvent(new Event("ironcrew-language-change"));
  }, [settings]);

  useEffect(() => {
    if (oauthResult) {
      setTab("oauth");
      setOauthStatus(null);
      if (!oauthResult.error) {
        setModels(null);
      }
    }
  }, [oauthResult]);

  useEffect(() => {
    if (tab === "oauth" && !oauthStatus) {
      void loadOAuthStatus().catch(console.error);
    }
  }, [tab, oauthStatus, loadOAuthStatus]);

  useEffect(() => {
    if (tab !== "cli" || cliModels) return;
    setCliModelsLoading(true);
    getCliModels()
      .then(setCliModels)
      .catch(console.error)
      .finally(() => setCliModelsLoading(false));
  }, [tab, cliModels]);

  useEffect(() => {
    if (tab !== "oauth" || !oauthStatus || models) return;
    const hasConnected = Object.values(oauthStatus.providers).some((provider) => provider.connected);
    if (!hasConnected) return;
    setModelsLoading(true);
    getOAuthModels()
      .then(setModels)
      .catch(console.error)
      .finally(() => setModelsLoading(false));
  }, [tab, oauthStatus, models]);

  useEffect(() => {
    if (oauthResult) {
      const timer = setTimeout(() => onOauthResultClear?.(), 8000);
      return () => clearTimeout(timer);
    }
  }, [oauthResult, onOauthResultClear]);

  useEffect(() => {
    return () => {
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    };
  }, []);

  function handleSave() {
    const nextLocale = normalizeLanguage(form.language);
    writeStoredValue(LANGUAGE_STORAGE_KEY, nextLocale);
    window.dispatchEvent(new Event("ironcrew-language-change"));
    persistSettings(form);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  function handleConnect(provider: OAuthConnectProvider) {
    const redirectTo = window.location.origin + window.location.pathname;
    window.location.assign(getOAuthStartUrl(provider, redirectTo));
  }

  const startDeviceCodeFlow = useCallback(async () => {
    setDeviceError(null);
    setDeviceStatus(null);
    try {
      const dc = await startGitHubDeviceFlow();
      setDeviceCode(dc);
      setDeviceStatus("polling");
      window.open(dc.verificationUri, "_blank");

      let intervalMs = Math.max((dc.interval || 5) * 1000, 5000);
      const expiresAt = Date.now() + (dc.expiresIn || 900) * 1000;
      let stopped = false;

      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);

      const poll = () => {
        if (stopped) return;
        pollTimerRef.current = setTimeout(async () => {
          if (stopped) return;
          if (Date.now() > expiresAt) {
            stopped = true;
            pollTimerRef.current = null;
            setDeviceStatus("expired");
            setDeviceCode(null);
            setDeviceError(
              t({
                ko: "코드가 만료되었습니다. 다시 시도하세요.",
                en: "Code expired. Please try again.",
                ja: "コードの有効期限が切れました。再試行してください。",
                zh: "Code expired. Please try again.",
                de: "Code abgelaufen. Bitte erneut versuchen.",
              }),
            );
            return;
          }

          try {
            const result = await pollGitHubDevice(dc.stateId);
            if (result.status === "complete") {
              stopped = true;
              pollTimerRef.current = null;
              setDeviceStatus("complete");
              setDeviceCode(null);
              await loadOAuthStatus();
              return;
            } else if (result.status === "expired" || result.status === "denied") {
              stopped = true;
              pollTimerRef.current = null;
              setDeviceStatus(result.status);
              setDeviceError(
                result.status === "expired"
                  ? t({
                      ko: "코드가 만료되었습니다",
                      en: "Code expired",
                      ja: "コードの期限切れ",
                      zh: "Code expired",
                      de: "Code abgelaufen",
                    })
                  : t({
                      ko: "인증이 거부되었습니다",
                      en: "Authentication denied",
                      ja: "認証が拒否されました",
                      zh: "Authentication denied",
                      de: "Authentifizierung verweigert",
                    }),
              );
              return;
            } else if (result.status === "slow_down") {
              intervalMs += 5000;
            } else if (result.status === "error") {
              stopped = true;
              pollTimerRef.current = null;
              setDeviceStatus("error");
              setDeviceError(
                result.error ||
                  t({
                    ko: "알 수 없는 오류",
                    en: "Unknown error",
                    ja: "不明なエラー",
                    zh: "Unknown error",
                    de: "Unbekannter Fehler",
                  }),
              );
              return;
            }
          } catch {
            // Network error — keep polling
          }

          poll();
        }, intervalMs);
      };

      poll();
    } catch (error) {
      setDeviceError(error instanceof Error ? error.message : String(error));
      setDeviceStatus("error");
    }
  }, [loadOAuthStatus, t]);

  const handleDisconnect = useCallback(
    async (provider: OAuthConnectProvider) => {
      setDisconnecting(provider);
      try {
        await disconnectOAuth(provider);
        await loadOAuthStatus();
        if (provider === "github-copilot") {
          setDeviceCode(null);
          setDeviceStatus(null);
          if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
        }
      } catch (error) {
        console.error("Disconnect failed:", error);
      } finally {
        setDisconnecting(null);
      }
    },
    [loadOAuthStatus],
  );

  const handleRefreshOAuthToken = useCallback(
    async (provider: OAuthConnectProvider) => {
      setRefreshing(provider);
      try {
        await refreshOAuthToken(provider);
        await loadOAuthStatus();
      } catch (error) {
        console.error("Manual refresh failed:", error);
      } finally {
        setRefreshing(null);
      }
    },
    [loadOAuthStatus],
  );

  const updateAccountDraft = useCallback((accountId: string, patch: AccountDraftPatch) => {
    setAccountDrafts((prev) => ({
      ...prev,
      [accountId]: {
        label: prev[accountId]?.label ?? "",
        modelOverride: prev[accountId]?.modelOverride ?? "",
        priority: prev[accountId]?.priority ?? "100",
        ...patch,
      },
    }));
  }, []);

  const handleActivateAccount = useCallback(
    async (provider: OAuthConnectProvider, accountId: string, currentlyActive: boolean) => {
      setSavingAccountId(accountId);
      try {
        await activateOAuthAccount(provider, accountId, currentlyActive ? "remove" : "add");
        await loadOAuthStatus();
      } catch (error) {
        console.error("Activate account failed:", error);
      } finally {
        setSavingAccountId(null);
      }
    },
    [loadOAuthStatus],
  );

  const handleSaveAccount = useCallback(
    async (accountId: string) => {
      const draft = accountDrafts[accountId];
      if (!draft) return;
      setSavingAccountId(accountId);
      try {
        await updateOAuthAccount(accountId, {
          label: draft.label.trim() || null,
          model_override: draft.modelOverride.trim() || null,
          priority: Number.isFinite(Number(draft.priority)) ? Math.max(1, Math.round(Number(draft.priority))) : 100,
        });
        await loadOAuthStatus();
      } catch (error) {
        console.error("Save account failed:", error);
      } finally {
        setSavingAccountId(null);
      }
    },
    [accountDrafts, loadOAuthStatus],
  );

  const handleToggleAccount = useCallback(
    async (accountId: string, nextStatus: "active" | "disabled") => {
      setSavingAccountId(accountId);
      try {
        await updateOAuthAccount(accountId, { status: nextStatus });
        await loadOAuthStatus();
      } catch (error) {
        console.error("Toggle account failed:", error);
      } finally {
        setSavingAccountId(null);
      }
    },
    [loadOAuthStatus],
  );

  const handleDeleteAccount = useCallback(
    async (provider: OAuthConnectProvider, accountId: string) => {
      if (
        !window.confirm(
          t({
            ko: "이 OAuth 계정을 삭제하시겠습니까?",
            en: "Delete this OAuth account?",
            ja: "この OAuth アカウントを削除しますか？",
            zh: "Delete this OAuth account?",
            de: "Dieses OAuth-Konto löschen?",
          }),
        )
      ) {
        return;
      }

      setSavingAccountId(accountId);
      try {
        await deleteOAuthAccount(provider, accountId);
        await loadOAuthStatus();
      } catch (error) {
        console.error("Delete account failed:", error);
      } finally {
        setSavingAccountId(null);
      }
    },
    [loadOAuthStatus, t],
  );

  return (
    <div className="mx-auto w-full max-w-5xl space-y-4 sm:space-y-6">
      <h2
        className="text-[9px] uppercase tracking-[0.05em]"
        style={{ fontFamily: "'Press Start 2P', monospace", color: "var(--text-muted, #71717a)" }}
      >
        {t({ ko: "설정", en: "Settings", ja: "設정", zh: "Settings", de: "Einstellungen" })}
      </h2>

      <div className={isMobile ? "" : "flex gap-6"}>
        <SettingsTabNav
          tab={tab}
          setTab={setTab}
          t={t}
          isMobile={isMobile}
          drawerOpen={drawerOpen}
          onToggleDrawer={toggleDrawer}
        />

        <div className={isMobile ? "mt-4" : "min-w-0 flex-1"}>
          {tab === "general" && (
            <GeneralSettingsTab t={t} form={form} setForm={setForm} saved={saved} onSave={handleSave} />
          )}

          {tab === "cli" && (
            <CliSettingsTab
              t={t}
              cliStatus={cliStatus}
              cliModels={cliModels}
              cliModelsLoading={cliModelsLoading}
              form={form}
              setForm={setForm}
              persistSettings={persistSettings}
              onRefresh={refreshCliTab}
            />
          )}

          {tab === "oauth" && (
            <OAuthSettingsTab
              t={t}
              localeTag={localeTag}
              form={form}
              setForm={setForm}
              persistSettings={persistSettings}
              oauthLoading={oauthLoading}
              oauthStatus={oauthStatus}
              oauthResult={oauthResult}
              onOauthResultClear={onOauthResultClear}
              onRefresh={refreshOAuthTab}
              models={models}
              modelsLoading={modelsLoading}
              refreshing={refreshing}
              disconnecting={disconnecting}
              savingAccountId={savingAccountId}
              accountDrafts={accountDrafts}
              onConnect={handleConnect}
              onDisconnect={handleDisconnect}
              onRefreshToken={handleRefreshOAuthToken}
              onUpdateAccountDraft={updateAccountDraft}
              onActivateAccount={handleActivateAccount}
              onSaveAccount={handleSaveAccount}
              onToggleAccount={handleToggleAccount}
              onDeleteAccount={handleDeleteAccount}
              deviceCode={deviceCode}
              deviceStatus={deviceStatus}
              deviceError={deviceError}
              onStartDeviceCodeFlow={startDeviceCodeFlow}
            />
          )}

          {tab === "api" && <ApiSettingsTab t={t} localeTag={localeTag} apiState={apiState} />}

          {tab === "gateway" && (
            <GatewaySettingsTab t={t} form={form} setForm={setForm} persistSettings={persistSettings} />
          )}

          {tab === "knowledge" && (
            <KnowledgeSettingsTab t={t} form={form} setForm={setForm} persistSettings={persistSettings} />
          )}

          {tab === "comfyui" && <ComfyUiSettingsTab t={t} />}

          {tab === "connectors" && <ConnectorSettingsTab t={t} />}

          {tab === "mcp" && <McpSettingsTab t={t} />}

          {tab === "servers" && <ServersSettingsTab t={t} agents={agents} />}

          {tab === "workflow_packs" && <WorkflowPackSettingsTab t={t} />}

          {tab === "observability" && <ObservabilitySettingsTab t={t} />}
        </div>
      </div>
    </div>
  );
}
