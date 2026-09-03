import { useCallback, useEffect, useMemo, useState } from "react";
import type { OAuthStatus } from "../../api";
import { getCliModels, getOAuthStatus, isApiRequestError, updateAgent } from "../../api";
import { useI18n } from "../../i18n";
import type { Agent, CliModelInfo, ReasoningLevelOption, WorkflowPackKey } from "../../types";
import { STATUS_CONFIG } from "./constants";

const CLI_MODEL_OVERRIDE_PROVIDERS: Agent["cli_provider"][] = ["claude", "codex", "gemini", "opencode", "openclaw"];
const CODEX_REASONING_FALLBACK_OPTIONS: ReasoningLevelOption[] = [
  { effort: "low", description: "Faster, lower depth" },
  { effort: "medium", description: "Balanced default" },
  { effort: "high", description: "Higher reasoning depth" },
  { effort: "xhigh", description: "Maximum reasoning depth" },
];

export function useAgentDetailState(
  agent: Agent,
  activeOfficeWorkflowPack: WorkflowPackKey,
  onAgentUpdated?: () => void,
) {
  const { t } = useI18n();

  // CLI editing state
  const [editingCli, setEditingCli] = useState(false);
  const [selectedCli, setSelectedCli] = useState(agent.cli_provider);
  const [selectedOAuthAccountId, setSelectedOAuthAccountId] = useState(agent.oauth_account_id ?? "");
  const [selectedApiProviderId, setSelectedApiProviderId] = useState(agent.api_provider_id ?? "");
  const [selectedApiModel, setSelectedApiModel] = useState(agent.api_model ?? "");
  const [selectedCliModel, setSelectedCliModel] = useState(agent.cli_model ?? "");
  const [selectedCliReasoningLevel, setSelectedCliReasoningLevel] = useState(agent.cli_reasoning_level ?? "");
  const [selectedCliProfile, setSelectedCliProfile] = useState(agent.cli_profile ?? "");
  const [savingCli, setSavingCli] = useState(false);
  const [oauthStatus, setOauthStatus] = useState<OAuthStatus | null>(null);
  const [oauthLoading, setOauthLoading] = useState(false);
  const [cliModels, setCliModels] = useState<Record<string, CliModelInfo[]>>({});
  const [cliModelsLoading, setCliModelsLoading] = useState(false);

  // Planning lead state
  const [savingPlanningLead, setSavingPlanningLead] = useState(false);
  const [actsAsPlanningLead, setActsAsPlanningLead] = useState(Number(agent.acts_as_planning_leader ?? 0) === 1);

  // Derived values
  const statusCfg = STATUS_CONFIG[agent.status] ?? STATUS_CONFIG.idle;
  const oauthProviderKey =
    selectedCli === "copilot" ? "github-copilot" : selectedCli === "antigravity" ? "antigravity" : null;
  const activeOAuthAccounts = useMemo(() => {
    if (!oauthProviderKey || !oauthStatus) return [];
    return (oauthStatus.providers[oauthProviderKey]?.accounts ?? []).filter(
      (account) => account.active && account.status === "active",
    );
  }, [oauthProviderKey, oauthStatus]);
  const requiresOAuthAccount = selectedCli === "copilot" || selectedCli === "antigravity";
  const requiresApiProvider = selectedCli === "api";
  const supportsCliModelOverride = CLI_MODEL_OVERRIDE_PROVIDERS.includes(selectedCli);
  const selectedCliModelOptions = useMemo(() => cliModels[selectedCli] ?? [], [cliModels, selectedCli]);
  const selectedCliModelMeta = useMemo(
    () => selectedCliModelOptions.find((model) => model.slug === selectedCliModel),
    [selectedCliModelOptions, selectedCliModel],
  );
  const codexReasoningOptions = useMemo(() => {
    if (selectedCli !== "codex") return [];
    if (selectedCliModelMeta?.reasoningLevels && selectedCliModelMeta.reasoningLevels.length > 0) {
      return selectedCliModelMeta.reasoningLevels;
    }
    return CODEX_REASONING_FALLBACK_OPTIONS;
  }, [selectedCli, selectedCliModelMeta]);
  const canSaveCli = requiresApiProvider ? false : !requiresOAuthAccount || Boolean(selectedOAuthAccountId);

  const getReasoningDescription = useCallback(
    (effort: string, fallback?: string) => {
      switch (effort) {
        case "low":
          return t({
            ko: "빠름, 낮은 깊이",
            en: "Faster, lower depth",
            ja: "高速・浅い推論",
            zh: "Faster, lower depth",
            de: "Schneller, geringere Tiefe",
          });
        case "medium":
          return t({
            ko: "균형 기본값",
            en: "Balanced default",
            ja: "バランス既定",
            zh: "Balanced default",
            de: "Ausgewogener Standard",
          });
        case "high":
          return t({
            ko: "높은 추론 깊이",
            en: "Higher reasoning depth",
            ja: "高い推論深度",
            zh: "Higher reasoning depth",
            de: "Höhere Argumentationstiefe",
          });
        case "xhigh":
          return t({
            ko: "최대 추론 깊이",
            en: "Maximum reasoning depth",
            ja: "最大推論深度",
            zh: "Maximum reasoning depth",
            de: "Maximale Argumentationstiefe",
          });
        default:
          return fallback || "";
      }
    },
    [t],
  );

  // Effects — sync state from agent prop
  useEffect(() => {
    setSelectedCli(agent.cli_provider);
    setSelectedOAuthAccountId(agent.oauth_account_id ?? "");
    setSelectedApiProviderId(agent.api_provider_id ?? "");
    setSelectedApiModel(agent.api_model ?? "");
    setSelectedCliModel(agent.cli_model ?? "");
    setSelectedCliReasoningLevel(agent.cli_reasoning_level ?? "");
    setSelectedCliProfile(agent.cli_profile ?? "");
    setActsAsPlanningLead(Number(agent.acts_as_planning_leader ?? 0) === 1);
  }, [
    agent.id,
    agent.cli_provider,
    agent.oauth_account_id,
    agent.api_provider_id,
    agent.api_model,
    agent.cli_model,
    agent.cli_reasoning_level,
    agent.cli_profile,
    agent.acts_as_planning_leader,
  ]);

  useEffect(() => {
    if (!editingCli || !requiresOAuthAccount) return;
    setOauthLoading(true);
    getOAuthStatus()
      .then(setOauthStatus)
      .catch((err: unknown) => console.error("Failed to load OAuth status:", err))
      .finally(() => setOauthLoading(false));
  }, [editingCli, requiresOAuthAccount]);

  useEffect(() => {
    if (!editingCli || !supportsCliModelOverride || Object.keys(cliModels).length > 0) return;
    let cancelled = false;
    setCliModelsLoading(true);
    getCliModels()
      .then((models: Record<string, CliModelInfo[]>) => {
        if (cancelled) return;
        setCliModels(models);
      })
      .catch((err: unknown) => console.error("Failed to load CLI models:", err))
      .finally(() => {
        if (!cancelled) setCliModelsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [editingCli, supportsCliModelOverride, cliModels]);

  useEffect(() => {
    if (!requiresOAuthAccount) {
      if (selectedOAuthAccountId) setSelectedOAuthAccountId("");
      return;
    }
    if (activeOAuthAccounts.length === 0) return;
    if (!selectedOAuthAccountId || !activeOAuthAccounts.some((account) => account.id === selectedOAuthAccountId)) {
      setSelectedOAuthAccountId(activeOAuthAccounts[0].id);
    }
  }, [requiresOAuthAccount, activeOAuthAccounts, selectedOAuthAccountId]);

  useEffect(() => {
    if (!supportsCliModelOverride && selectedCliModel) {
      setSelectedCliModel("");
    }
  }, [supportsCliModelOverride, selectedCliModel]);

  useEffect(() => {
    if (selectedCli !== "codex" && selectedCliReasoningLevel) {
      setSelectedCliReasoningLevel("");
      return;
    }
    if (selectedCli === "codex" && selectedCliReasoningLevel) {
      const isValid = codexReasoningOptions.some((level) => level.effort === selectedCliReasoningLevel);
      if (!isValid) setSelectedCliReasoningLevel("");
    }
  }, [selectedCli, selectedCliReasoningLevel, codexReasoningOptions]);

  // Handlers
  const handleSaveCli = useCallback(async () => {
    setSavingCli(true);
    try {
      await updateAgent(agent.id, {
        cli_provider: selectedCli,
        oauth_account_id: requiresOAuthAccount ? selectedOAuthAccountId || null : null,
        api_provider_id: requiresApiProvider ? selectedApiProviderId || null : null,
        api_model: requiresApiProvider ? selectedApiModel || null : null,
        cli_model: supportsCliModelOverride ? selectedCliModel || null : null,
        cli_reasoning_level: selectedCli === "codex" ? selectedCliReasoningLevel || null : null,
        cli_profile: selectedCli === "openclaw" ? selectedCliProfile || null : null,
      });
      onAgentUpdated?.();
      setEditingCli(false);
    } catch (error) {
      console.error("Failed to update CLI:", error);
    } finally {
      setSavingCli(false);
    }
  }, [
    agent.id,
    selectedCli,
    requiresOAuthAccount,
    selectedOAuthAccountId,
    requiresApiProvider,
    selectedApiProviderId,
    selectedApiModel,
    supportsCliModelOverride,
    selectedCliModel,
    selectedCliReasoningLevel,
    selectedCliProfile,
    onAgentUpdated,
  ]);

  const handleCancelCliEdit = useCallback(() => {
    setEditingCli(false);
    setSelectedCli(agent.cli_provider);
    setSelectedOAuthAccountId(agent.oauth_account_id ?? "");
    setSelectedApiProviderId(agent.api_provider_id ?? "");
    setSelectedApiModel(agent.api_model ?? "");
    setSelectedCliModel(agent.cli_model ?? "");
    setSelectedCliReasoningLevel(agent.cli_reasoning_level ?? "");
    setSelectedCliProfile(agent.cli_profile ?? "");
  }, [
    agent.cli_provider,
    agent.oauth_account_id,
    agent.api_provider_id,
    agent.api_model,
    agent.cli_model,
    agent.cli_reasoning_level,
    agent.cli_profile,
  ]);

  const resolvePackLabel = useCallback(
    (packKey: WorkflowPackKey) => {
      switch (packKey) {
        case "development":
          return t({ ko: "개발", en: "Development", ja: "開発", zh: "Development", de: "Entwicklung" });
        case "video_preprod":
          return t({
            ko: "영상 프리프로덕션",
            en: "Video Pre-production",
            ja: "動画プリプロ",
            zh: "Video Pre-production",
            de: "Video-Vorproduktion",
          });
        case "web_research_report":
          return t({
            ko: "웹 리서치 리포트",
            en: "Web Research Report",
            ja: "Webリサーチ",
            zh: "Web Research Report",
            de: "Web-Recherchebericht",
          });
        default:
          return packKey;
      }
    },
    [t],
  );

  const handlePlanningLeadToggle = useCallback(
    async (nextChecked: boolean) => {
      if (agent.role !== "team_leader" || savingPlanningLead) return;
      const previous = actsAsPlanningLead;
      setActsAsPlanningLead(nextChecked);
      setSavingPlanningLead(true);

      try {
        await updateAgent(agent.id, {
          acts_as_planning_leader: nextChecked ? 1 : 0,
          workflow_pack_key: activeOfficeWorkflowPack,
        });
        onAgentUpdated?.();
      } catch (error) {
        if (
          nextChecked &&
          isApiRequestError(error) &&
          error.status === 409 &&
          error.code === "planning_leader_exists"
        ) {
          const details = (error.details ?? {}) as {
            existing_leader?: { name?: string | null; name_ko?: string | null };
            pack_key?: WorkflowPackKey | null;
          };
          const existingLeaderName = String(
            details.existing_leader?.name_ko ||
              details.existing_leader?.name ||
              t({ ko: "기존 리더", en: "current leader", de: "aktueller Leiter" }),
          ).trim();
          const packKey = details.pack_key ?? activeOfficeWorkflowPack;
          const packLabel = resolvePackLabel(packKey);
          const confirmed = window.confirm(
            t({
              ko: `이미 ${existingLeaderName}가 ${packLabel} 오피스팩의 리더입니다. 변경하시겠습니까?`,
              en: `${existingLeaderName} is already the leader for the ${packLabel} office pack. Change leader?`,
              ja: `${existingLeaderName}さんが既に${packLabel}オフィスパックのリーダーです。変更しますか？`,
              zh: `${existingLeaderName} is already the leader for the ${packLabel} office pack. Change leader?`,
              de: `${existingLeaderName} ist bereits Leiter des ${packLabel}-Office-Pakets. Leiter wechseln?`,
            }),
          );
          if (confirmed) {
            try {
              await updateAgent(agent.id, {
                acts_as_planning_leader: 1,
                workflow_pack_key: activeOfficeWorkflowPack,
                force_planning_leader_override: true,
              });
              onAgentUpdated?.();
              return;
            } catch (overrideError) {
              console.error("Failed to override planning lead:", overrideError);
            }
          }
        } else {
          console.error("Failed to update planning lead:", error);
        }
        setActsAsPlanningLead(previous);
      } finally {
        setSavingPlanningLead(false);
      }
    },
    [
      activeOfficeWorkflowPack,
      agent.id,
      agent.role,
      actsAsPlanningLead,
      onAgentUpdated,
      resolvePackLabel,
      savingPlanningLead,
      t,
    ],
  );

  return {
    // CLI editing state
    editingCli,
    setEditingCli,
    selectedCli,
    setSelectedCli,
    selectedOAuthAccountId,
    setSelectedOAuthAccountId,
    selectedApiProviderId,
    selectedApiModel,
    selectedCliModel,
    setSelectedCliModel,
    selectedCliReasoningLevel,
    setSelectedCliReasoningLevel,
    selectedCliProfile,
    setSelectedCliProfile,
    savingCli,
    oauthLoading,
    cliModelsLoading,

    // Planning lead state
    savingPlanningLead,
    actsAsPlanningLead,

    // Derived values
    statusCfg,
    oauthProviderKey,
    activeOAuthAccounts,
    requiresOAuthAccount,
    requiresApiProvider,
    supportsCliModelOverride,
    selectedCliModelOptions,
    selectedCliModelMeta,
    codexReasoningOptions,
    canSaveCli,

    // Handlers
    getReasoningDescription,
    handleSaveCli,
    handleCancelCliEdit,
    resolvePackLabel,
    handlePlanningLeadToggle,
  };
}

export type AgentDetailState = ReturnType<typeof useAgentDetailState>;
