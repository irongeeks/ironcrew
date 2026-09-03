import { useCallback, useMemo, useState } from "react";
import type { Department } from "../types";
import { useI18n } from "../i18n";
import { normalizeOfficeWorkflowPack } from "../app/office-workflow-pack";
import { buildSpriteMap } from "./AgentAvatar";
import AgentFormModal from "./agent-manager/AgentFormModal";
import AgentsTab from "./agent-manager/AgentsTab";
import { ICON_SPRITE_POOL } from "./agent-manager/constants";
import DepartmentFormModal from "./agent-manager/DepartmentFormModal";
import DepartmentsTab from "./agent-manager/DepartmentsTab";
import { StackedSpriteIcon } from "./agent-manager/EmojiPicker";
import type { AgentManagerProps } from "./agent-manager/types";
import { useIsolatedPackPersist } from "./agent-manager/useIsolatedPackPersist";
import { useAgentCrud } from "./agent-manager/useAgentCrud";
import { useDeptReorder } from "./agent-manager/useDeptReorder";
import { pickRandomSpritePair } from "./agent-manager/utils";

export default function AgentManager({
  agents,
  departments,
  onAgentsChange,
  activeOfficeWorkflowPack,
  dbBackedOfficePack = false,
  onSaveOfficePackProfile,
  departmentRoomAssignments = {},
  onSaveDepartmentRoomAssignments,
}: AgentManagerProps) {
  const { t, locale } = useI18n();
  const isKo = locale.startsWith("ko");

  const tr = (ko: string, en: string, de = en) => t({ ko, en, ja: en, zh: en, de });
  const officePackKey = normalizeOfficeWorkflowPack(activeOfficeWorkflowPack);
  const isIsolatedPack = officePackKey !== "development";
  const useDbBackedPack = isIsolatedPack && dbBackedOfficePack;

  const [subTab, setSubTab] = useState<"agents" | "departments">("agents");
  const [search, setSearch] = useState("");
  const [deptTab, setDeptTab] = useState("all");

  const [showDeptModal, setShowDeptModal] = useState(false);
  const [editDept, setEditDept] = useState<Department | null>(null);

  const { persistIsolatedProfile } = useIsolatedPackPersist({
    isIsolatedPack,
    officePackKey,
    onSaveOfficePackProfile,
  });

  const {
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
  } = useAgentCrud({
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
  });

  const {
    deptOrder,
    deptOrderDirty,
    reorderSaving,
    draggingDeptId,
    dragOverDeptId,
    dragOverPosition,
    moveDept,
    saveDeptOrder,
    resetDeptOrder,
    handleDeptDragStart,
    handleDeptDragOver,
    handleDeptDrop,
    clearDeptDragState,
  } = useDeptReorder({
    agents,
    departments,
    isIsolatedPack,
    useDbBackedPack,
    officePackKey,
    onAgentsChange,
    persistIsolatedProfile,
  });

  const spriteMap = buildSpriteMap(agents);
  const randomIconSprites = useMemo(
    () => ({
      tab: pickRandomSpritePair(ICON_SPRITE_POOL),
      total: pickRandomSpritePair(ICON_SPRITE_POOL),
    }),
    [],
  );

  const filteredAgents = useMemo(
    () =>
      agents.filter((agent) => {
        if (deptTab !== "all" && agent.department_id !== deptTab) return false;
        if (!search) return true;
        const query = search.toLowerCase();
        return (
          agent.name.toLowerCase().includes(query) ||
          agent.name_ko.toLowerCase().includes(query) ||
          (agent.name_ja || "").toLowerCase().includes(query) ||
          (agent.name_zh || "").toLowerCase().includes(query)
        );
      }),
    [agents, deptTab, search],
  );

  const sortedAgents = useMemo(() => {
    const roleOrder: Record<string, number> = { team_leader: 0, senior: 1, junior: 2, intern: 3 };
    return [...filteredAgents].sort(
      (a, b) => (roleOrder[a.role] ?? 9) - (roleOrder[b.role] ?? 9) || a.name.localeCompare(b.name),
    );
  }, [filteredAgents]);

  const openCreateDept = useCallback(() => {
    setEditDept(null);
    setShowDeptModal(true);
  }, []);

  const openEditDept = useCallback((department: Department) => {
    setEditDept(department);
    setShowDeptModal(true);
  }, []);

  const closeDeptModal = useCallback(() => {
    setShowDeptModal(false);
    setEditDept(null);
  }, []);

  const handleIsolatedDepartmentSave = useCallback(
    async (input: {
      mode: "create" | "update";
      id: string;
      payload: {
        name: string;
        name_ko: string;
        name_ja: string | null;
        name_zh: string | null;
        icon: string;
        color: string;
        description: string | null;
        prompt: string | null;
        sort_order: number;
      };
    }) => {
      if (!isIsolatedPack) return;
      const nextDepartments =
        input.mode === "create"
          ? [
              ...departments,
              {
                id: input.id,
                name: input.payload.name,
                name_ko: input.payload.name_ko,
                name_ja: input.payload.name_ja,
                name_zh: input.payload.name_zh,
                icon: input.payload.icon,
                color: input.payload.color,
                description: input.payload.description,
                prompt: input.payload.prompt,
                sort_order: input.payload.sort_order,
                created_at: Date.now(),
              },
            ]
          : departments.map((department) =>
              department.id === input.id
                ? {
                    ...department,
                    name: input.payload.name,
                    name_ko: input.payload.name_ko,
                    name_ja: input.payload.name_ja,
                    name_zh: input.payload.name_zh,
                    icon: input.payload.icon,
                    color: input.payload.color,
                    description: input.payload.description,
                    prompt: input.payload.prompt,
                    sort_order: input.payload.sort_order,
                  }
                : department,
            );
      await persistIsolatedProfile(nextDepartments, agents);
    },
    [agents, departments, isIsolatedPack, persistIsolatedProfile],
  );

  const handleIsolatedDepartmentDelete = useCallback(
    async (departmentId: string) => {
      if (!isIsolatedPack) return;
      const filteredDepartments = departments
        .filter((department) => department.id !== departmentId)
        .sort((a, b) => a.sort_order - b.sort_order)
        .map((department, index) => ({
          ...department,
          sort_order: index + 1,
        }));
      const nextAgents = agents.map((agent) =>
        agent.department_id === departmentId
          ? {
              ...agent,
              department_id: null,
            }
          : agent,
      );
      await persistIsolatedProfile(filteredDepartments, nextAgents);
    },
    [agents, departments, isIsolatedPack, persistIsolatedProfile],
  );

  const handleAssignRoom = useCallback(
    async (departmentId: string, roomSlot: number | null) => {
      if (!onSaveDepartmentRoomAssignments) return;
      const nextAssignments: Record<string, number> = { ...departmentRoomAssignments };

      delete nextAssignments[departmentId];
      if (roomSlot !== null) {
        for (const [deptId, slot] of Object.entries(nextAssignments)) {
          if (slot === roomSlot) {
            delete nextAssignments[deptId];
          }
        }
        nextAssignments[departmentId] = roomSlot;
      }

      try {
        await onSaveDepartmentRoomAssignments(nextAssignments);
      } catch (error) {
        console.error("Save department room assignment failed:", error);
      }
    },
    [departmentRoomAssignments, onSaveDepartmentRoomAssignments],
  );

  return (
    <div className="mx-auto max-w-4xl space-y-4 sm:space-y-5">
      <div className="flex items-center justify-end gap-2">
        <button
          onClick={openCreateDept}
          className="px-3 py-2 rounded-lg text-sm font-medium transition-all hover:opacity-90 active:opacity-80 shadow-sm"
          style={{ background: "#7c3aed", color: "#ffffff", boxShadow: "0 1px 3px rgba(124,58,237,0.3)" }}
        >
          + {tr("부서 추가", "Add Dept", "Abt. hinzufügen")}
        </button>
        <button
          onClick={openCreate}
          className="px-4 py-2 rounded-lg text-sm font-medium transition-all"
          style={{
            background: "var(--bg-glow)",
            border: "1px solid var(--border-strong)",
            color: "var(--th-text-primary)",
          }}
        >
          + {tr("신규 채용", "Hire Agent", "Agent einstellen")}
        </button>
      </div>

      <div
        className="flex gap-1 p-1 rounded-xl"
        style={{ background: "var(--th-card-bg)", border: "1px solid var(--th-card-border)" }}
      >
        {[
          {
            key: "agents" as const,
            label: tr("직원관리", "Agents", "Agenten"),
            icon: <StackedSpriteIcon sprites={randomIconSprites.tab} />,
          },
          { key: "departments" as const, label: tr("부서관리", "Departments", "Abteilungen"), icon: "🏢" },
        ].map((tab) => (
          <button
            key={tab.key}
            onClick={() => setSubTab(tab.key)}
            className={`flex-1 flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
              subTab === tab.key ? "shadow-sm" : "hover:bg-white/5"
            }`}
            style={
              subTab === tab.key
                ? { background: "var(--accent-subtle)", color: "var(--accent)", border: "1px solid var(--accent-dim)" }
                : { color: "var(--th-text-muted)" }
            }
          >
            <span>{tab.icon}</span>
            {tab.label}
          </button>
        ))}
      </div>

      {subTab === "agents" && (
        <AgentsTab
          tr={tr}
          locale={locale}
          isKo={isKo}
          agents={agents}
          departments={departments}
          deptTab={deptTab}
          setDeptTab={setDeptTab}
          search={search}
          setSearch={setSearch}
          sortedAgents={sortedAgents}
          spriteMap={spriteMap}
          confirmDeleteId={confirmDeleteId}
          setConfirmDeleteId={setConfirmDeleteId}
          onEditAgent={openEdit}
          onEditDepartment={openEditDept}
          onQuickAssignTask={handleQuickAssignTask}
          onQuickMessageAgent={handleQuickMessageAgent}
          onQuickViewDetails={openEdit}
          onDeleteAgent={handleDelete}
          saving={saving}
          randomIconSprites={{ total: randomIconSprites.total }}
          onOpenDepartmentsTab={() => setSubTab("departments")}
        />
      )}

      {subTab === "departments" && (
        <DepartmentsTab
          tr={tr}
          locale={locale}
          agents={agents}
          departments={departments}
          deptOrder={deptOrder}
          deptOrderDirty={deptOrderDirty}
          reorderSaving={reorderSaving}
          draggingDeptId={draggingDeptId}
          dragOverDeptId={dragOverDeptId}
          dragOverPosition={dragOverPosition}
          onSaveOrder={saveDeptOrder}
          onCancelOrder={resetDeptOrder}
          onMoveDept={moveDept}
          onEditDept={openEditDept}
          onDragStart={handleDeptDragStart}
          onDragOver={handleDeptDragOver}
          onDrop={handleDeptDrop}
          onDragEnd={clearDeptDragState}
          roomAssignments={departmentRoomAssignments}
          onAssignRoom={handleAssignRoom}
        />
      )}

      {showModal && (
        <AgentFormModal
          isKo={isKo}
          locale={locale}
          tr={tr}
          form={form}
          setForm={setForm}
          departments={departments}
          servers={servers}
          isEdit={!!modalAgent}
          saving={saving}
          onSave={handleSave}
          onClose={closeModal}
        />
      )}

      {showDeptModal && (
        <DepartmentFormModal
          locale={locale}
          tr={tr}
          department={editDept}
          departments={departments}
          workflowPackKey={isIsolatedPack ? officePackKey : undefined}
          onSave={() => {
            if (!isIsolatedPack || useDbBackedPack) onAgentsChange();
          }}
          onSaveDepartment={isIsolatedPack && !useDbBackedPack ? handleIsolatedDepartmentSave : undefined}
          onDeleteDepartment={isIsolatedPack && !useDbBackedPack ? handleIsolatedDepartmentDelete : undefined}
          onClose={closeDeptModal}
        />
      )}
    </div>
  );
}
