import type { Agent, Department, OfficePackProfile, ServerNode, WorkflowPackKey } from "../../types";
import type { DragEvent } from "react";

export type Translator = (ko: string, en: string) => string;

export interface AgentManagerProps {
  agents: Agent[];
  departments: Department[];
  onAgentsChange: () => void;
  activeOfficeWorkflowPack: WorkflowPackKey;
  dbBackedOfficePack?: boolean;
  onSaveOfficePackProfile: (packKey: WorkflowPackKey, profile: OfficePackProfile) => Promise<void>;
  departmentRoomAssignments?: Record<string, number>;
  onSaveDepartmentRoomAssignments?: (assignments: Record<string, number>) => Promise<void>;
}

export interface FormData {
  name: string;
  name_ko: string;
  name_ja: string;
  name_zh: string;
  department_id: string;
  role: import("../../types").AgentRole;
  cli_provider: import("../../types").CliProvider;
  cli_profile: string;
  avatar_emoji: string;
  sprite_number: number | null;
  allowed_server_ids: string[];
  personality: string;
}

export interface DeptForm {
  id: string;
  name: string;
  name_ko: string;
  name_ja: string;
  name_zh: string;
  icon: string;
  color: string;
  description: string;
  prompt: string;
}

/* ── useIsolatedPackPersist ── */

export interface UseIsolatedPackPersistParams {
  isIsolatedPack: boolean;
  officePackKey: WorkflowPackKey;
  onSaveOfficePackProfile: (packKey: WorkflowPackKey, profile: OfficePackProfile) => Promise<void>;
}

export interface UseIsolatedPackPersistReturn {
  persistIsolatedProfile: (nextDepartments: Department[], nextAgents: Agent[]) => Promise<void>;
}

/* ── useAgentCrud ── */

export interface UseAgentCrudParams {
  agents: Agent[];
  departments: Department[];
  deptTab: string;
  isIsolatedPack: boolean;
  useDbBackedPack: boolean;
  officePackKey: WorkflowPackKey;
  isKo: boolean;
  tr: (ko: string, en: string, de?: string) => string;
  onAgentsChange: () => void;
  persistIsolatedProfile: (nextDepartments: Department[], nextAgents: Agent[]) => Promise<void>;
}

export interface UseAgentCrudReturn {
  modalAgent: Agent | null;
  showModal: boolean;
  form: FormData;
  setForm: React.Dispatch<React.SetStateAction<FormData>>;
  saving: boolean;
  confirmDeleteId: string | null;
  setConfirmDeleteId: React.Dispatch<React.SetStateAction<string | null>>;
  servers: ServerNode[];
  openCreate: () => void;
  openEdit: (agent: Agent) => void;
  closeModal: () => void;
  handleSave: () => Promise<void>;
  handleDelete: (id: string) => Promise<void>;
  handleQuickAssignTask: (agent: Agent) => Promise<void>;
  handleQuickMessageAgent: (agent: Agent) => Promise<void>;
}

/* ── useDeptReorder ── */

export interface UseDeptReorderParams {
  agents: Agent[];
  departments: Department[];
  isIsolatedPack: boolean;
  useDbBackedPack: boolean;
  officePackKey: WorkflowPackKey;
  onAgentsChange: () => void;
  persistIsolatedProfile: (nextDepartments: Department[], nextAgents: Agent[]) => Promise<void>;
}

export interface UseDeptReorderReturn {
  deptOrder: Department[];
  deptOrderDirty: boolean;
  reorderSaving: boolean;
  draggingDeptId: string | null;
  dragOverDeptId: string | null;
  dragOverPosition: "before" | "after" | null;
  moveDept: (index: number, direction: -1 | 1) => void;
  saveDeptOrder: () => Promise<void>;
  resetDeptOrder: () => void;
  handleDeptDragStart: (deptId: string, event: DragEvent<HTMLDivElement>) => void;
  handleDeptDragOver: (deptId: string, event: DragEvent<HTMLDivElement>) => void;
  handleDeptDrop: (deptId: string, event: DragEvent<HTMLDivElement>) => void;
  clearDeptDragState: () => void;
}
