import { useCallback, useEffect, useMemo, useState } from "react";
import type { TaskType } from "../../../types";
import { createDraftId, loadCreateTaskDrafts, saveCreateTaskDrafts, type CreateTaskDraft } from "../constants";

interface DraftFormState {
  title: string;
  description: string;
  departmentId: string;
  taskType: TaskType;
  priority: number;
  assignAgentId: string;
  projectId: string;
  projectQuery: string;
  createNewProjectMode: boolean;
  newProjectPath: string;
  packInputValues: Record<string, string>;
  skippedPhases: string[];
}

interface UseDraftStateParams {
  localeTag: string;
  submitBusy: boolean;
  formState: DraftFormState;
  applyFormState: (draft: CreateTaskDraft) => void;
  onClose: () => void;
}

export function useDraftState({ localeTag, submitBusy, formState, applyFormState, onClose }: UseDraftStateParams) {
  const initialDrafts = useMemo(() => loadCreateTaskDrafts(), []);
  const [drafts, setDrafts] = useState<CreateTaskDraft[]>(initialDrafts);
  const [restorePromptOpen, setRestorePromptOpen] = useState<boolean>(initialDrafts.length > 0);
  const [selectedRestoreDraftId, setSelectedRestoreDraftId] = useState<string | null>(initialDrafts[0]?.id ?? null);
  const [draftModalOpen, setDraftModalOpen] = useState(false);
  const [activeDraftId, setActiveDraftId] = useState<string | null>(null);

  const persistDrafts = useCallback((updater: (prev: CreateTaskDraft[]) => CreateTaskDraft[]) => {
    setDrafts((prev) => {
      const next = updater(prev)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 20);
      saveCreateTaskDrafts(next);
      return next;
    });
  }, []);

  const applyDraft = useCallback(
    (draft: CreateTaskDraft) => {
      applyFormState(draft);
      setActiveDraftId(draft.id);
    },
    [applyFormState],
  );

  const hasWorkingDraftData = useMemo(
    () =>
      Boolean(formState.title.trim()) ||
      Boolean(formState.description.trim()) ||
      Boolean(formState.departmentId) ||
      formState.taskType !== "general" ||
      formState.priority !== 3 ||
      Boolean(formState.assignAgentId) ||
      Boolean(formState.projectId) ||
      Boolean(formState.projectQuery.trim()) ||
      formState.createNewProjectMode ||
      Boolean(formState.newProjectPath.trim()) ||
      Object.keys(formState.packInputValues).length > 0 ||
      formState.skippedPhases.length > 0,
    [formState],
  );

  const saveCurrentAsDraft = useCallback(() => {
    if (!hasWorkingDraftData) return;

    const draft: CreateTaskDraft = {
      id: activeDraftId ?? createDraftId(),
      title: formState.title.trim(),
      description: formState.description,
      departmentId: formState.departmentId,
      taskType: formState.taskType,
      priority: formState.priority,
      assignAgentId: formState.assignAgentId,
      projectId: formState.projectId,
      projectQuery: formState.projectQuery,
      createNewProjectMode: formState.createNewProjectMode,
      newProjectPath: formState.newProjectPath,
      packInputValues: formState.packInputValues,
      skippedPhases: formState.skippedPhases.length > 0 ? formState.skippedPhases : undefined,
      updatedAt: Date.now(),
    };

    persistDrafts((prev) => {
      const idx = prev.findIndex((item) => item.id === draft.id);
      if (idx < 0) return [draft, ...prev];
      const next = [...prev];
      next[idx] = draft;
      return next;
    });
    setActiveDraftId(draft.id);
  }, [activeDraftId, formState, hasWorkingDraftData, persistDrafts]);

  const deleteDraft = useCallback(
    (draftId: string) => {
      persistDrafts((prev) => prev.filter((item) => item.id !== draftId));
      setActiveDraftId((prev) => (prev === draftId ? null : prev));
    },
    [persistDrafts],
  );

  const clearDrafts = useCallback(() => {
    persistDrafts(() => []);
    setActiveDraftId(null);
  }, [persistDrafts]);

  const handleRequestClose = useCallback(() => {
    if (!submitBusy) saveCurrentAsDraft();
    onClose();
  }, [onClose, saveCurrentAsDraft, submitBusy]);

  useEffect(() => {
    if (drafts.length === 0 && restorePromptOpen) {
      setRestorePromptOpen(false);
    }
  }, [drafts.length, restorePromptOpen]);

  const restoreCandidates = useMemo(() => drafts.slice(0, 3), [drafts]);
  const selectedRestoreDraft = useMemo(
    () => restoreCandidates.find((item) => item.id === selectedRestoreDraftId) ?? restoreCandidates[0] ?? null,
    [restoreCandidates, selectedRestoreDraftId],
  );

  useEffect(() => {
    if (restoreCandidates.length === 0) {
      if (selectedRestoreDraftId !== null) setSelectedRestoreDraftId(null);
      return;
    }
    if (!restoreCandidates.some((item) => item.id === selectedRestoreDraftId)) {
      setSelectedRestoreDraftId(restoreCandidates[0].id);
    }
  }, [restoreCandidates, selectedRestoreDraftId]);

  const formatDraftTimestamp = useCallback(
    (ts: number) =>
      new Intl.DateTimeFormat(localeTag, {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(ts)),
    [localeTag],
  );

  return {
    drafts,
    restorePromptOpen,
    setRestorePromptOpen,
    selectedRestoreDraftId,
    setSelectedRestoreDraftId,
    draftModalOpen,
    setDraftModalOpen,
    restoreCandidates,
    selectedRestoreDraft,
    formatDraftTimestamp,
    applyDraft,
    deleteDraft,
    clearDrafts,
    handleRequestClose,
  };
}
