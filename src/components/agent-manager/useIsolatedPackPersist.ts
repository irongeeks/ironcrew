import { useCallback } from "react";
import type { UseIsolatedPackPersistParams, UseIsolatedPackPersistReturn } from "./types";
import type { Agent, Department } from "../../types";

export function useIsolatedPackPersist({
  isIsolatedPack,
  officePackKey,
  onSaveOfficePackProfile,
}: UseIsolatedPackPersistParams): UseIsolatedPackPersistReturn {
  const persistIsolatedProfile = useCallback(
    async (nextDepartments: Department[], nextAgents: Agent[]) => {
      if (!isIsolatedPack) return;
      await onSaveOfficePackProfile(officePackKey, {
        departments: nextDepartments,
        agents: nextAgents,
        updated_at: Date.now(),
      });
    },
    [isIsolatedPack, officePackKey, onSaveOfficePackProfile],
  );

  return { persistIsolatedProfile };
}
