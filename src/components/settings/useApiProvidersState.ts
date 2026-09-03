import { useCallback, useEffect, useRef, useState } from "react";
import {
  createApiProvider,
  deleteApiProvider,
  getAgents,
  getApiProviders,
  getDepartments,
  testApiProvider,
  updateAgent,
  updateApiProvider,
} from "../../api";
import type { ApiProvider } from "../../api";
import type { Agent, Department } from "../../types";
import type { ApiAssignTarget, ApiFormState, ApiStateBundle, SettingsTab, TFunction } from "./types";

const DEFAULT_API_FORM: ApiFormState = {
  name: "",
  type: "openai",
  base_url: "https://api.openai.com/v1",
  api_key: "",
  allow_local: false,
};

export function useApiProvidersState({ tab, t }: { tab: SettingsTab; t: TFunction }): ApiStateBundle {
  const [apiProviders, setApiProviders] = useState<ApiProvider[]>([]);
  const [apiProvidersLoading, setApiProvidersLoading] = useState(false);
  const [apiAddMode, setApiAddMode] = useState(false);
  const [apiEditingId, setApiEditingId] = useState<string | null>(null);
  const [apiForm, setApiForm] = useState<ApiFormState>(DEFAULT_API_FORM);
  const [apiSaving, setApiSaving] = useState(false);
  const [apiTesting, setApiTesting] = useState<string | null>(null);
  const [apiTestResult, setApiTestResult] = useState<Record<string, { ok: boolean; msg: string }>>({});
  const [apiModelsExpanded, setApiModelsExpanded] = useState<Record<string, boolean>>({});
  const [apiAssignTarget, setApiAssignTarget] = useState<ApiAssignTarget | null>(null);
  const [apiAssignAgents, setApiAssignAgents] = useState<Agent[]>([]);
  const [apiAssignDepts, setApiAssignDepts] = useState<Department[]>([]);
  const [apiAssigning, setApiAssigning] = useState(false);

  const apiLoadedRef = useRef(false);

  const loadApiProviders = useCallback(async () => {
    setApiProvidersLoading(true);
    try {
      const providers = await getApiProviders();
      setApiProviders(providers);
      apiLoadedRef.current = true;
    } catch (error) {
      console.error("Failed to load API providers:", error);
    } finally {
      setApiProvidersLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab === "api" && !apiLoadedRef.current && !apiProvidersLoading) {
      void loadApiProviders();
    }
  }, [tab, apiProvidersLoading, loadApiProviders]);

  const handleApiProviderSave = useCallback(async () => {
    if (!apiForm.name.trim() || !apiForm.base_url.trim()) return;
    setApiSaving(true);
    try {
      if (apiEditingId) {
        await updateApiProvider(apiEditingId, {
          name: apiForm.name,
          type: apiForm.type,
          base_url: apiForm.base_url,
          allow_local: apiForm.allow_local,
          ...(apiForm.api_key ? { api_key: apiForm.api_key } : {}),
        });
      } else {
        await createApiProvider({
          name: apiForm.name,
          type: apiForm.type,
          base_url: apiForm.base_url,
          api_key: apiForm.api_key || undefined,
          allow_local: apiForm.allow_local,
        });
      }
      setApiAddMode(false);
      setApiEditingId(null);
      setApiForm(DEFAULT_API_FORM);
      await loadApiProviders();
    } catch (error) {
      console.error("API provider save failed:", error);
    } finally {
      setApiSaving(false);
    }
  }, [apiEditingId, apiForm, loadApiProviders]);

  const handleApiProviderDelete = useCallback(
    async (id: string) => {
      try {
        await deleteApiProvider(id);
        await loadApiProviders();
      } catch (error) {
        console.error("API provider delete failed:", error);
      }
    },
    [loadApiProviders],
  );

  const handleApiProviderTest = useCallback(
    async (id: string) => {
      setApiTesting(id);
      setApiTestResult((prev) => ({ ...prev, [id]: { ok: false, msg: "" } }));
      try {
        const result = await testApiProvider(id);
        setApiTestResult((prev) => ({
          ...prev,
          [id]: result.ok
            ? {
                ok: true,
                msg: `${result.model_count} ${t({ ko: "개 모델 발견", en: "models found", ja: "モデル検出", zh: "models found", de: "Modelle gefunden" })}`,
              }
            : { ok: false, msg: result.error?.slice(0, 200) || `HTTP ${result.status}` },
        }));
        if (result.ok) await loadApiProviders();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setApiTestResult((prev) => ({ ...prev, [id]: { ok: false, msg: message } }));
      } finally {
        setApiTesting(null);
      }
    },
    [loadApiProviders, t],
  );

  const handleApiProviderToggle = useCallback(
    async (id: string, enabled: boolean) => {
      try {
        await updateApiProvider(id, { enabled: !enabled });
        await loadApiProviders();
      } catch (error) {
        console.error("API provider toggle failed:", error);
      }
    },
    [loadApiProviders],
  );

  const handleApiEditStart = useCallback((provider: ApiProvider) => {
    setApiEditingId(provider.id);
    setApiAddMode(true);
    setApiForm({
      name: provider.name,
      type: provider.type,
      base_url: provider.base_url,
      api_key: "",
      allow_local: provider.allow_local,
    });
  }, []);

  const handleApiModelAssign = useCallback(async (providerId: string, model: string) => {
    setApiAssignTarget({ providerId, model });
    try {
      const [agents, depts] = await Promise.all([getAgents(), getDepartments()]);
      setApiAssignAgents(agents);
      setApiAssignDepts(depts);
    } catch (error) {
      console.error("Failed to load agents:", error);
    }
  }, []);

  const handleApiAssignToAgent = useCallback(
    async (agentId: string) => {
      if (!apiAssignTarget) return;
      setApiAssigning(true);
      try {
        await updateAgent(agentId, {
          cli_provider: "api",
          api_provider_id: apiAssignTarget.providerId,
          api_model: apiAssignTarget.model,
        });
        setApiAssignAgents((prev) =>
          prev.map((agent) =>
            agent.id === agentId
              ? {
                  ...agent,
                  cli_provider: "api",
                  api_provider_id: apiAssignTarget.providerId,
                  api_model: apiAssignTarget.model,
                }
              : agent,
          ),
        );
      } catch (error) {
        console.error("Failed to assign API model to agent:", error);
      } finally {
        setApiAssigning(false);
      }
    },
    [apiAssignTarget],
  );

  return {
    apiProviders,
    apiProvidersLoading,
    apiAddMode,
    apiEditingId,
    apiForm,
    apiSaving,
    apiTesting,
    apiTestResult,
    apiModelsExpanded,
    apiAssignTarget,
    apiAssignAgents,
    apiAssignDepts,
    apiAssigning,
    setApiAddMode,
    setApiEditingId,
    setApiForm,
    setApiModelsExpanded,
    setApiAssignTarget,
    loadApiProviders,
    handleApiProviderSave,
    handleApiProviderDelete,
    handleApiProviderTest,
    handleApiProviderToggle,
    handleApiEditStart,
    handleApiModelAssign,
    handleApiAssignToAgent,
  };
}

export { DEFAULT_API_FORM };
