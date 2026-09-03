import { useCallback, useEffect, useState } from "react";
import type { Agent, ServerNode } from "../../types";
import { createAgent, createTask, deleteAgent, getServers, sendMessage, updateAgent } from "../../api";
import { resolveAgentCharacterIndex } from "../AgentAvatar";
import { BLANK } from "./constants";
import type { FormData, UseAgentCrudParams, UseAgentCrudReturn } from "./types";

export function useAgentCrud({
  agents,
  departments,
  deptTab,
  isIsolatedPack,
  useDbBackedPack,
  officePackKey,
  isKo,
  tr,
  onAgentsChange,
  persistIsolatedProfile,
}: UseAgentCrudParams): UseAgentCrudReturn {
  const [modalAgent, setModalAgent] = useState<Agent | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState<FormData>({ ...BLANK });
  const [saving, setSaving] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [servers, setServers] = useState<ServerNode[]>([]);

  useEffect(() => {
    getServers()
      .then(setServers)
      .catch((error) => {
        console.error("Load servers failed:", error);
        setServers([]);
      });
  }, []);

  const openCreate = useCallback(() => {
    setModalAgent(null);
    setForm({ ...BLANK, department_id: deptTab !== "all" ? deptTab : departments[0]?.id || "" });
    setShowModal(true);
  }, [deptTab, departments]);

  const openEdit = useCallback(
    (agent: Agent) => {
      setModalAgent(agent);
      const computed = agent.sprite_number ?? resolveAgentCharacterIndex(agent) ?? 0;
      setForm({
        name: agent.name,
        name_ko: agent.name_ko,
        name_ja: agent.name_ja || "",
        name_zh: agent.name_zh || "",
        department_id: agent.department_id || "",
        role: agent.role,
        cli_provider: agent.cli_provider,
        cli_profile: agent.cli_profile || "",
        avatar_emoji: agent.avatar_emoji,
        sprite_number: computed,
        allowed_server_ids: Array.isArray(agent.allowed_server_ids) ? agent.allowed_server_ids : [],
        personality: agent.personality || "",
      });
      setShowModal(true);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [agents],
  );

  const closeModal = useCallback(() => {
    setShowModal(false);
    setModalAgent(null);
  }, []);

  const handleSave = useCallback(async () => {
    if (!form.name.trim()) return;
    setSaving(true);
    try {
      const departmentId = form.department_id.trim();
      const basePayload = {
        name: form.name.trim(),
        name_ko: form.name_ko.trim(),
        name_ja: form.name_ja.trim(),
        name_zh: form.name_zh.trim(),
        role: form.role,
        cli_provider: form.cli_provider,
        cli_profile: form.cli_provider === "openclaw" ? form.cli_profile.trim() || null : null,
        avatar_emoji: form.avatar_emoji || "🤖",
        sprite_number: form.sprite_number,
        allowed_server_ids: form.allowed_server_ids,
        personality: form.personality.trim() || null,
      };
      if (isIsolatedPack) {
        if (useDbBackedPack) {
          if (modalAgent) {
            await updateAgent(modalAgent.id, {
              ...basePayload,
              department_id: departmentId || null,
              workflow_pack_key: officePackKey,
            });
            const nextAgents = agents.map((agent) =>
              agent.id === modalAgent.id
                ? {
                    ...agent,
                    ...basePayload,
                    department_id: departmentId || null,
                  }
                : agent,
            );
            await persistIsolatedProfile(departments, nextAgents);
          } else {
            const createdAgent = await createAgent({
              ...basePayload,
              department_id: departmentId || null,
              workflow_pack_key: officePackKey,
            });
            await persistIsolatedProfile(departments, [...agents, createdAgent]);
          }
          onAgentsChange();
        } else {
          const nextAgents = modalAgent
            ? agents.map((agent) =>
                agent.id === modalAgent.id
                  ? {
                      ...agent,
                      ...basePayload,
                      department_id: departmentId || null,
                    }
                  : agent,
              )
            : [
                ...agents,
                {
                  id:
                    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
                      ? crypto.randomUUID()
                      : `agent-${Date.now()}`,
                  ...basePayload,
                  department_id: departmentId || null,
                  status: "idle" as const,
                  current_task_id: null,
                  created_at: Date.now(),
                },
              ];
          await persistIsolatedProfile(departments, nextAgents);
        }
      } else {
        if (modalAgent) {
          await updateAgent(modalAgent.id, {
            ...basePayload,
            department_id: departmentId || null,
          });
        } else {
          await createAgent({
            ...basePayload,
            department_id: departmentId || null,
          });
        }
        onAgentsChange();
      }
      closeModal();
    } catch (err) {
      console.error("Save failed:", err);
    } finally {
      setSaving(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    agents,
    closeModal,
    departments,
    form,
    isIsolatedPack,
    modalAgent,
    onAgentsChange,
    persistIsolatedProfile,
    useDbBackedPack,
  ]);

  const handleDelete = useCallback(
    async (id: string) => {
      setSaving(true);
      try {
        if (isIsolatedPack) {
          if (useDbBackedPack) {
            await deleteAgent(id);
            const nextAgents = agents.filter((agent) => agent.id !== id);
            await persistIsolatedProfile(departments, nextAgents);
            onAgentsChange();
          } else {
            const nextAgents = agents.filter((agent) => agent.id !== id);
            await persistIsolatedProfile(departments, nextAgents);
          }
        } else {
          await deleteAgent(id);
          onAgentsChange();
        }
        setConfirmDeleteId(null);
        if (modalAgent?.id === id) closeModal();
      } catch (err) {
        console.error("Delete failed:", err);
      } finally {
        setSaving(false);
      }
    },
    [
      agents,
      closeModal,
      departments,
      isIsolatedPack,
      modalAgent,
      onAgentsChange,
      persistIsolatedProfile,
      useDbBackedPack,
    ],
  );

  const handleQuickAssignTask = useCallback(
    async (agent: Agent) => {
      const title = window.prompt(
        tr("할당할 작업 제목을 입력하세요", "Enter a task title to assign", "Aufgabentitel zum Zuweisen eingeben"),
        isKo ? `${agent.name_ko} 긴급 작업` : `${agent.name} priority task`,
      );
      if (!title || !title.trim()) return;
      try {
        await createTask({
          title: title.trim(),
          department_id: agent.department_id ?? undefined,
          assigned_agent_id: agent.id,
          workflow_pack_key: officePackKey,
        });
      } catch (error) {
        console.error("Quick assign failed:", error);
      }
    },
    [isKo, officePackKey, tr],
  );

  const handleQuickMessageAgent = useCallback(
    async (agent: Agent) => {
      const content = window.prompt(
        tr(
          "에이전트에게 보낼 메시지를 입력하세요",
          "Enter a message for this agent",
          "Nachricht für diesen Agenten eingeben",
        ),
        isKo ? `${agent.name_ko}, 이 작업 우선 처리 부탁합니다.` : `${agent.name}, please prioritize this task.`,
      );
      if (!content || !content.trim()) return;
      try {
        await sendMessage({
          receiver_type: "agent",
          receiver_id: agent.id,
          content: content.trim(),
          message_type: "chat",
        });
      } catch (error) {
        console.error("Quick message failed:", error);
      }
    },
    [isKo, tr],
  );

  return {
    modalAgent,
    showModal,
    form,
    setForm,
    saving,
    confirmDeleteId,
    setConfirmDeleteId,
    servers,
    openCreate,
    openEdit,
    closeModal,
    handleSave,
    handleDelete,
    handleQuickAssignTask,
    handleQuickMessageAgent,
  };
}
