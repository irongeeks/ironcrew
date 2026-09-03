import { useCallback, useEffect } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";

import * as api from "../api";
import { bootstrapSession } from "../api/core";
import type { DecisionInboxItem } from "../components/chat/decision-inbox";
import { detectBrowserLanguage } from "../i18n";
import type {
  Agent,
  CompanySettings,
  CompanyStats,
  Department,
  MeetingPresence,
  ServerAllocation,
  ServerNode,
  SubTask,
  Task,
} from "../types";
import { DEFAULT_SETTINGS } from "../types";
import { ROOM_THEMES_STORAGE_KEY } from "./constants";
import { mapWorkflowDecisionItemsRaw } from "./decision-inbox";
import { normalizeOfficeWorkflowPack } from "./office-workflow-pack";
import type { RoomThemeMap } from "./types";
import {
  isRoomThemeMap,
  isUserLanguagePinned,
  mergeSettingsWithDefaults,
  readStoredClientLanguage,
  syncClientLanguage,
} from "./utils";

type StoredRoomThemes = {
  themes: RoomThemeMap;
  hasStored: boolean;
};

type UseAppBootstrapDataParams = {
  initialRoomThemes: StoredRoomThemes;
  hasLocalRoomThemesRef: MutableRefObject<boolean>;
  setDepartments: Dispatch<SetStateAction<Department[]>>;
  setAgents: Dispatch<SetStateAction<Agent[]>>;
  setTasks: Dispatch<SetStateAction<Task[]>>;
  setStats: Dispatch<SetStateAction<CompanyStats | null>>;
  setSettings: Dispatch<SetStateAction<CompanySettings>>;
  setSubtasks: Dispatch<SetStateAction<SubTask[]>>;
  setServers: Dispatch<SetStateAction<ServerNode[]>>;
  setServerAllocations: Dispatch<SetStateAction<ServerAllocation[]>>;
  setMeetingPresence: Dispatch<SetStateAction<MeetingPresence[]>>;
  setDecisionInboxItems: Dispatch<SetStateAction<DecisionInboxItem[]>>;
  setCustomRoomThemes: Dispatch<SetStateAction<RoomThemeMap>>;
  setLoading: Dispatch<SetStateAction<boolean>>;
};

export function useAppBootstrapData({
  initialRoomThemes,
  hasLocalRoomThemesRef,
  setDepartments,
  setAgents,
  setTasks,
  setStats,
  setSettings,
  setSubtasks,
  setServers,
  setServerAllocations,
  setMeetingPresence,
  setDecisionInboxItems,
  setCustomRoomThemes,
  setLoading,
}: UseAppBootstrapDataParams): void {
  const fetchAll = useCallback(async () => {
    try {
      // Ensure the session (CSRF token) is established before any API calls
      // to avoid spurious 401 errors on initial page load.
      await bootstrapSession();

      // Settings is loaded first because server-side /api/settings can trigger one-time
      // office-pack hydration, and we want follow-up agent/department fetches to include it.
      const sett = await api.getSettings();
      const activePackKey = normalizeOfficeWorkflowPack(sett.officeWorkflowPack ?? "development");
      const includeSeedAgents = activePackKey !== "development";
      const [depts, ags, tks, sts, subs, servers, allocations, presence, decisionItems] = await Promise.all([
        api.getDepartments({ workflowPackKey: activePackKey }).catch((err) => {
          console.error("[bootstrap] getDepartments failed:", err instanceof Error ? err.message : err);
          return [] as Department[];
        }),
        api.getAgents({ includeSeed: includeSeedAgents }).catch((err) => {
          console.error("[bootstrap] getAgents failed:", err instanceof Error ? err.message : err);
          return [] as Agent[];
        }),
        api.getTasks().catch((err) => {
          console.error("[bootstrap] getTasks failed:", err instanceof Error ? err.message : err);
          return [] as Task[];
        }),
        api.getStats().catch((err) => {
          console.error("[bootstrap] getStats failed:", err instanceof Error ? err.message : err);
          return null as CompanyStats | null;
        }),
        api.getActiveSubtasks().catch((err) => {
          console.error("[bootstrap] getActiveSubtasks failed:", err instanceof Error ? err.message : err);
          return [] as SubTask[];
        }),
        api.getServers().catch((err) => {
          console.warn("[bootstrap] getServers failed:", err instanceof Error ? err.message : err);
          return [];
        }),
        api.getServerAllocations("active").catch((err) => {
          console.warn("[bootstrap] getServerAllocations failed:", err instanceof Error ? err.message : err);
          return [];
        }),
        api.getMeetingPresence().catch((err) => {
          console.warn("[bootstrap] getMeetingPresence failed:", err instanceof Error ? err.message : err);
          return [];
        }),
        api.getDecisionInbox().catch((err) => {
          console.warn("[bootstrap] getDecisionInbox failed:", err instanceof Error ? err.message : err);
          return [];
        }),
      ]);
      setDepartments(depts);
      setAgents(ags);
      setTasks(tks);
      setStats(sts);
      const mergedSettings = mergeSettingsWithDefaults(sett);
      const autoDetectedLanguage = detectBrowserLanguage();
      const storedClientLanguage = readStoredClientLanguage();
      const shouldAutoAssignLanguage =
        !isUserLanguagePinned() && !storedClientLanguage && mergedSettings.language === DEFAULT_SETTINGS.language;
      const nextSettings = shouldAutoAssignLanguage
        ? { ...mergedSettings, language: autoDetectedLanguage }
        : mergedSettings;

      setSettings(nextSettings);
      syncClientLanguage(nextSettings.language);
      const dbRoomThemes = isRoomThemeMap(nextSettings.roomThemes) ? nextSettings.roomThemes : undefined;

      if (!hasLocalRoomThemesRef.current && dbRoomThemes && Object.keys(dbRoomThemes).length > 0) {
        setCustomRoomThemes(dbRoomThemes);
        hasLocalRoomThemesRef.current = true;
        try {
          window.localStorage.setItem(ROOM_THEMES_STORAGE_KEY, JSON.stringify(dbRoomThemes));
        } catch {
          // ignore quota errors
        }
      }

      if (
        hasLocalRoomThemesRef.current &&
        Object.keys(initialRoomThemes.themes).length > 0 &&
        (!dbRoomThemes || Object.keys(dbRoomThemes).length === 0)
      ) {
        api.saveRoomThemes(initialRoomThemes.themes).catch((error) => {
          console.error("Room theme sync to DB failed:", error);
        });
      }

      if (shouldAutoAssignLanguage && mergedSettings.language !== autoDetectedLanguage) {
        api.saveSettings(nextSettings).catch((error) => {
          console.error("Auto language sync failed:", error);
        });
      }
      setSubtasks(subs);
      setServers(servers);
      setServerAllocations(allocations);
      setMeetingPresence(presence);
      setDecisionInboxItems(mapWorkflowDecisionItemsRaw(decisionItems ?? []));
    } finally {
      setLoading(false);
    }
  }, [
    hasLocalRoomThemesRef,
    initialRoomThemes.themes,
    setAgents,
    setCustomRoomThemes,
    setDecisionInboxItems,
    setDepartments,
    setLoading,
    setMeetingPresence,
    setServerAllocations,
    setServers,
    setSettings,
    setStats,
    setSubtasks,
    setTasks,
  ]);

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);
}
