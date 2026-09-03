import type { CreateTaskDraft, ManualPathEntry, MissingPathPrompt, TFunction } from "../constants";

export interface CreateTaskModalOverlaysProps {
  t: TFunction;
  localeTag: string;
  restorePromptOpen: boolean;
  selectedRestoreDraft: CreateTaskDraft | null;
  restoreCandidates: CreateTaskDraft[];
  selectedRestoreDraftId: string | null;
  formatDraftTimestamp: (timestamp: number) => string;
  submitWithoutProjectPromptOpen: boolean;
  missingPathPrompt: MissingPathPrompt | null;
  submitBusy: boolean;
  manualPathPickerOpen: boolean;
  manualPathLoading: boolean;
  manualPathCurrent: string;
  manualPathParent: string | null;
  manualPathEntries: ManualPathEntry[];
  manualPathTruncated: boolean;
  manualPathError: string | null;
  draftModalOpen: boolean;
  drafts: CreateTaskDraft[];
  onSelectRestoreDraft: (draftId: string) => void;
  onCloseRestorePrompt: () => void;
  onLoadSelectedRestoreDraft: () => void;
  onCloseSubmitWithoutProjectPrompt: () => void;
  onConfirmSubmitWithoutProject: () => void;
  onCloseMissingPathPrompt: () => void;
  onConfirmCreateMissingPath: () => void;
  onCloseManualPathPicker: () => void;
  onManualPathGoUp: () => void;
  onManualPathRefresh: () => void;
  onOpenManualPathEntry: (path: string) => void;
  onSelectManualCurrentPath: () => void;
  onCloseDraftModal: () => void;
  onLoadDraft: (draft: CreateTaskDraft) => void;
  onDeleteDraft: (draftId: string) => void;
  onClearDrafts: () => void;
}
