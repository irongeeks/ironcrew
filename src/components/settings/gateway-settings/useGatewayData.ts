import { useEffect, useMemo, useState } from "react";
import {
  getAgents,
  getDiscordReceiverStatus,
  getMessengerRuntimeSessions,
  getTelegramReceiverStatus,
  getWorkflowPacks,
} from "../../../api";
import { useSpriteMap } from "../../AgentAvatar";
import { WORKFLOW_PACK_KEYS, type Agent, type PackRegistryEntry, type WorkflowPackKey } from "../../../types";
import { fetchPackRegistry } from "../../../api/workflow-packs";
import type { ChannelSettingsTabProps } from "../types";
import { isWorkflowPackKey } from "./constants";
import { defaultWorkflowPackLabel } from "./state";

export function useGatewayData(t: ChannelSettingsTabProps["t"]) {
  const [runtimeLoading, setRuntimeLoading] = useState(false);
  const [runtimeSessions, setRuntimeSessions] = useState<Awaited<ReturnType<typeof getMessengerRuntimeSessions>>>([]);
  const [receiverLoading, setReceiverLoading] = useState(false);
  const [telegramReceiverStatus, setTelegramReceiverStatus] = useState<Awaited<
    ReturnType<typeof getTelegramReceiverStatus>
  > | null>(null);
  const [discordReceiverStatus, setDiscordReceiverStatus] = useState<Awaited<
    ReturnType<typeof getDiscordReceiverStatus>
  > | null>(null);
  const [agentsLoading, setAgentsLoading] = useState(false);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [workflowPacksLoading, setWorkflowPacksLoading] = useState(false);
  const [workflowPacks, setWorkflowPacks] = useState<Awaited<ReturnType<typeof getWorkflowPacks>>["packs"]>([]);
  const [registryPacks, setRegistryPacks] = useState<PackRegistryEntry[]>([]);

  useEffect(() => {
    fetchPackRegistry()
      .then(setRegistryPacks)
      .catch(() => {});
  }, []);

  const allPackKeys = useMemo(() => {
    if (registryPacks.length > 0) return registryPacks.map((p) => p.key);
    return [...WORKFLOW_PACK_KEYS] as string[];
  }, [registryPacks]);

  const spriteMap = useSpriteMap(agents);

  const agentById = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const agent of agents) {
      map.set(agent.id, agent);
    }
    return map;
  }, [agents]);

  const workflowPackOptions = useMemo(() => {
    const map = new Map<WorkflowPackKey, { key: WorkflowPackKey; name: string; enabled: boolean }>();
    for (const key of allPackKeys) {
      map.set(key, { key, name: defaultWorkflowPackLabel(t, key), enabled: true });
    }
    for (const pack of workflowPacks) {
      if (!isWorkflowPackKey(pack.key)) continue;
      const existing = map.get(pack.key);
      map.set(pack.key, {
        key: pack.key,
        name: typeof pack.name === "string" && pack.name.trim() ? pack.name.trim() : (existing?.name ?? pack.key),
        enabled: pack.enabled !== false,
      });
    }
    return Array.from(map.values());
  }, [workflowPacks, allPackKeys, t]);

  const workflowPackNameByKey = useMemo(() => {
    const map = new Map<WorkflowPackKey, string>();
    for (const option of workflowPackOptions) {
      map.set(option.key, option.name);
    }
    return map;
  }, [workflowPackOptions]);

  const loadRuntimeSessions = async () => {
    setRuntimeLoading(true);
    try {
      const sessions = await getMessengerRuntimeSessions();
      setRuntimeSessions(sessions);
    } catch {
      setRuntimeSessions([]);
    } finally {
      setRuntimeLoading(false);
    }
  };

  const loadAgents = async () => {
    setAgentsLoading(true);
    try {
      const rows = await getAgents();
      setAgents(rows);
    } catch {
      setAgents([]);
    } finally {
      setAgentsLoading(false);
    }
  };

  const loadWorkflowPacks = async () => {
    setWorkflowPacksLoading(true);
    try {
      const result = await getWorkflowPacks();
      setWorkflowPacks(result.packs ?? []);
    } catch {
      setWorkflowPacks([]);
    } finally {
      setWorkflowPacksLoading(false);
    }
  };

  const loadMessengerReceiverStatus = async () => {
    setReceiverLoading(true);
    try {
      const [telegramStatus, discordStatus] = await Promise.all([
        getTelegramReceiverStatus().catch(() => null),
        getDiscordReceiverStatus().catch(() => null),
      ]);
      setTelegramReceiverStatus(telegramStatus);
      setDiscordReceiverStatus(discordStatus);
    } catch {
      setTelegramReceiverStatus(null);
      setDiscordReceiverStatus(null);
    } finally {
      setReceiverLoading(false);
    }
  };

  useEffect(() => {
    void loadAgents();
    void loadWorkflowPacks();
  }, []);

  return {
    agents,
    agentsLoading,
    agentById,
    spriteMap,
    workflowPackOptions,
    workflowPacksLoading,
    workflowPackNameByKey,
    runtimeLoading,
    runtimeSessions,
    receiverLoading,
    telegramReceiverStatus,
    discordReceiverStatus,
    loadRuntimeSessions,
    loadMessengerReceiverStatus,
  };
}
