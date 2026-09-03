import { useCallback, useEffect, useMemo, useState } from "react";
import type { Agent, CompanySettings, Department, Task, WorkflowPackKey } from "../types";
import type { RoomThemeMap } from "./types";
import { fetchPackRegistry } from "../api/workflow-packs";
import {
  buildOfficePackStarterAgents,
  buildOfficePackPresentation,
  getOfficePackRoomThemes,
  listOfficePackOptions,
  mergeRegistryIntoPresets,
  normalizeOfficeWorkflowPack,
  PACK_PRESETS,
  resolveOfficePackSeedProvider,
  type PackPreset,
  type UiLanguageLike,
} from "./office-workflow-pack";
import { resolvePackAgentViews, resolvePackDepartmentsForDisplay } from "./office-pack-display";
import { applyOfficePackToTaskInput, filterTasksByOfficePack, type TaskCreateInput } from "./task-workflow-pack";

function sanitizeRoomAssignments(assignments: Record<string, unknown> | null | undefined): Record<string, number> {
  if (!assignments) return {};
  const normalized: Record<string, number> = {};
  for (const [departmentId, rawSlot] of Object.entries(assignments)) {
    const slot = Number(rawSlot);
    if (Number.isInteger(slot) && slot > 0) normalized[departmentId] = slot;
  }
  return normalized;
}

function applyDepartmentRoomAssignments(
  departments: Department[],
  roomAssignments: Record<string, number>,
): Department[] {
  if (departments.length <= 1 || Object.keys(roomAssignments).length === 0) return departments;
  return [...departments].sort((left, right) => {
    const leftSlot = roomAssignments[left.id];
    const rightSlot = roomAssignments[right.id];
    const leftAssigned = Number.isInteger(leftSlot);
    const rightAssigned = Number.isInteger(rightSlot);
    if (leftAssigned && rightAssigned && leftSlot !== rightSlot) return leftSlot - rightSlot;
    if (leftAssigned !== rightAssigned) return leftAssigned ? -1 : 1;
    if (left.sort_order !== right.sort_order) return left.sort_order - right.sort_order;
    return left.id.localeCompare(right.id);
  });
}

interface UseOfficePackResolutionParams {
  activeOfficeWorkflowPack: WorkflowPackKey;
  departments: Department[];
  agents: Agent[];
  tasks: Task[];
  settings: CompanySettings;
  customRoomThemes: RoomThemeMap;
  uiLanguage: UiLanguageLike;
  onCreateTask: (input: TaskCreateInput) => Promise<void>;
}

interface UseOfficePackResolutionResult {
  officePackKey: WorkflowPackKey;
  officePackOptions: Array<{ key: WorkflowPackKey; label: string; summary: string; slug: string; accent: number }>;
  officePackLabel: string;
  languageLabel: string;
  officePresentation: { departments: Department[]; agents: Agent[]; roomThemes: Record<string, unknown> };
  orderedManagerDepartments: Department[];
  managerAgents: Agent[];
  activeRoomAssignments: Record<string, number>;
  isHydratedOfficePack: boolean;
  tasksForActivePack: Task[];
  handleCreateTaskForActivePack: (input: TaskCreateInput) => Promise<void>;
}

export function useOfficePackResolution({
  activeOfficeWorkflowPack,
  departments,
  agents,
  tasks,
  settings,
  customRoomThemes,
  uiLanguage,
  onCreateTask,
}: UseOfficePackResolutionParams): UseOfficePackResolutionResult {
  const [registryPresets, setRegistryPresets] = useState<Record<string, PackPreset> | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchPackRegistry()
      .then((packs) => {
        if (!cancelled) {
          setRegistryPresets(mergeRegistryIntoPresets(packs));
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const activePresets = registryPresets ?? PACK_PRESETS;

  const officePackKey = normalizeOfficeWorkflowPack(activeOfficeWorkflowPack, activePresets);
  const officePackOptions = useMemo(
    () => listOfficePackOptions(uiLanguage, activePresets),
    [uiLanguage, activePresets],
  );
  const officePackLabel =
    uiLanguage === "ko"
      ? "오피스 팩"
      : uiLanguage === "ja"
        ? "オフィスパック"
        : uiLanguage === "zh"
          ? "办公室包"
          : uiLanguage === "de"
            ? "Office-Paket"
            : "Office Pack";
  const languageLabel =
    uiLanguage === "ko"
      ? "언어"
      : uiLanguage === "ja"
        ? "言語"
        : uiLanguage === "zh"
          ? "语言"
          : uiLanguage === "de"
            ? "Sprache"
            : "Language";
  const generatedOfficePresentation = useMemo(
    () =>
      buildOfficePackPresentation({
        packKey: officePackKey,
        locale: uiLanguage,
        departments,
        agents,
        customRoomThemes,
      }),
    [officePackKey, uiLanguage, departments, agents, customRoomThemes],
  );

  const activePackProfile =
    officePackKey === "development" ? null : (settings.officePackProfiles?.[officePackKey] ?? null);

  const seededPackAgents = useMemo(() => {
    if (officePackKey === "development") return [] as Agent[];
    if (activePackProfile?.agents?.length) return activePackProfile.agents;
    const drafts = buildOfficePackStarterAgents({
      packKey: officePackKey,
      departments: generatedOfficePresentation.departments,
      targetCount: 8,
      locale: uiLanguage,
    });
    const now = Date.now();
    return drafts.map((draft, index) => ({
      id: `${officePackKey}-seed-${index + 1}`,
      name: draft.name,
      name_ko: draft.name_ko,
      name_ja: draft.name_ja,
      name_zh: draft.name_zh,
      department_id: draft.department_id,
      role: draft.role,
      acts_as_planning_leader: draft.acts_as_planning_leader,
      cli_provider: resolveOfficePackSeedProvider({
        packKey: officePackKey,
        departmentId: draft.department_id,
        role: draft.role,
        seedIndex: index + 1,
        seedOrderInDepartment: draft.seed_order_in_department,
      }),
      avatar_emoji: draft.avatar_emoji,
      sprite_number: draft.sprite_number,
      personality: draft.personality,
      status: "idle" as const,
      current_task_id: null,
      created_at: now,
    }));
  }, [activePackProfile?.agents, generatedOfficePresentation.departments, officePackKey, uiLanguage]);

  const packProfileDepartments =
    officePackKey === "development"
      ? null
      : (activePackProfile?.departments ?? generatedOfficePresentation.departments);
  const packProfileAgents = officePackKey === "development" ? null : (activePackProfile?.agents ?? seededPackAgents);

  const isHydratedOfficePack = useMemo(() => {
    if (officePackKey === "development") return false;
    const hydrated = settings.officePackHydratedPacks;
    if (!Array.isArray(hydrated)) return false;
    return hydrated.map((value) => String(value ?? "").trim()).includes(officePackKey);
  }, [officePackKey, settings.officePackHydratedPacks]);

  const displayDepartments = useMemo(
    () =>
      resolvePackDepartmentsForDisplay({
        packKey: officePackKey,
        globalDepartments: departments,
        packDepartments: packProfileDepartments,
        preferPackProfile: !isHydratedOfficePack,
      }),
    [departments, isHydratedOfficePack, officePackKey, packProfileDepartments],
  );
  const activeRoomAssignments = useMemo(() => {
    const byPack = settings.departmentRoomAssignments?.[officePackKey] as Record<string, unknown> | undefined;
    return sanitizeRoomAssignments(byPack ?? null);
  }, [officePackKey, settings.departmentRoomAssignments]);
  const orderedDisplayDepartments = useMemo(
    () => applyDepartmentRoomAssignments(displayDepartments, activeRoomAssignments),
    [activeRoomAssignments, displayDepartments],
  );

  const { scopedAgents: officeScopedAgents } = useMemo(
    () =>
      resolvePackAgentViews({
        packKey: officePackKey,
        globalAgents: agents,
        packAgents: packProfileAgents,
      }),
    [agents, officePackKey, packProfileAgents],
  );

  const managerDepartments =
    officePackKey === "development"
      ? departments
      : isHydratedOfficePack
        ? displayDepartments
        : (activePackProfile?.departments ?? generatedOfficePresentation.departments);
  const orderedManagerDepartments = useMemo(
    () => applyDepartmentRoomAssignments(managerDepartments, activeRoomAssignments),
    [activeRoomAssignments, managerDepartments],
  );

  const managerAgents =
    officePackKey === "development"
      ? agents
      : isHydratedOfficePack
        ? officeScopedAgents
        : (activePackProfile?.agents ?? seededPackAgents);

  const officePresentation = useMemo(() => {
    if (officePackKey === "development") {
      return {
        ...generatedOfficePresentation,
        departments: applyDepartmentRoomAssignments(generatedOfficePresentation.departments, activeRoomAssignments),
      };
    }
    return {
      departments: orderedDisplayDepartments,
      agents: officeScopedAgents,
      roomThemes: {
        ...customRoomThemes,
        ...getOfficePackRoomThemes(officePackKey),
      },
    };
  }, [
    activeRoomAssignments,
    customRoomThemes,
    generatedOfficePresentation,
    officePackKey,
    officeScopedAgents,
    orderedDisplayDepartments,
  ]);

  const tasksForActivePack = useMemo(
    () => filterTasksByOfficePack(tasks, officePackKey, activePresets),
    [tasks, officePackKey, activePresets],
  );
  const handleCreateTaskForActivePack = useCallback(
    async (input: TaskCreateInput) => {
      await onCreateTask(applyOfficePackToTaskInput(input, officePackKey));
    },
    [onCreateTask, officePackKey],
  );

  return {
    officePackKey,
    officePackOptions,
    officePackLabel,
    languageLabel,
    officePresentation,
    orderedManagerDepartments,
    managerAgents,
    activeRoomAssignments,
    isHydratedOfficePack,
    tasksForActivePack,
    handleCreateTaskForActivePack,
  };
}
