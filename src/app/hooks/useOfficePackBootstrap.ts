import { useCallback, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";

import * as api from "../../api";
import { normalizeLanguage } from "../../i18n";
import type { Agent, CompanySettings, Department, OfficePackProfile, WorkflowPackKey } from "../../types";
import {
  buildOfficePackPresentation,
  buildOfficePackStarterAgents,
  getOfficePackMeta,
  resolveOfficePackSeedProvider,
} from "../office-workflow-pack";
import type { RoomThemeMap } from "../types";
import { mergeSettingsWithDefaults } from "../utils";

export interface UseOfficePackBootstrapParams {
  settings: CompanySettings;
  setSettings: Dispatch<SetStateAction<CompanySettings>>;
  departments: Department[];
  setDepartments: Dispatch<SetStateAction<Department[]>>;
  agents: Agent[];
  setAgents: Dispatch<SetStateAction<Agent[]>>;
  customRoomThemes: RoomThemeMap;
}

export interface UseOfficePackBootstrapResult {
  officePackBootstrappingLabel: string | null;
  handleOfficeWorkflowPackChange: (packKey: WorkflowPackKey) => void;
}

function readHydratedPackSet(source: CompanySettings): Set<string> {
  const raw = source.officePackHydratedPacks;
  if (!Array.isArray(raw)) return new Set<string>();
  return new Set(raw.map((value) => String(value ?? "").trim()).filter((value) => value.length > 0));
}

function getPackLabelByLanguage(packKey: WorkflowPackKey, language: string): string {
  const label = getOfficePackMeta(packKey).label;
  const lang = normalizeLanguage(language);
  if (lang === "ko") return label.ko || label.en;
  if (lang === "ja") return label.ja || label.en;
  if (lang === "zh") return label.zh || label.en;
  return label.en;
}

export function useOfficePackBootstrap({
  settings,
  setSettings,
  departments,
  setDepartments,
  agents,
  setAgents,
  customRoomThemes,
}: UseOfficePackBootstrapParams): UseOfficePackBootstrapResult {
  const [officePackBootstrappingLabel, setOfficePackBootstrappingLabel] = useState<string | null>(null);
  const officePackBootstrapReqRef = useRef(0);

  const maybeBuildSeedProfileForPack = useCallback(
    (packKey: WorkflowPackKey, sourceSettings: CompanySettings): OfficePackProfile | null => {
      if (packKey === "development") return null;

      const existingProfile = sourceSettings.officePackProfiles?.[packKey];
      if (existingProfile?.departments?.length && existingProfile?.agents?.length) {
        return null;
      }

      const locale = normalizeLanguage(sourceSettings.language) as "ko" | "en" | "ja" | "zh" | "de";
      const presentation = buildOfficePackPresentation({
        packKey,
        locale,
        departments,
        agents,
        customRoomThemes,
      });
      if (presentation.departments.length <= 0) return null;

      const starterDrafts = buildOfficePackStarterAgents({
        packKey,
        departments: presentation.departments,
        targetCount: 8,
        locale,
      });
      if (starterDrafts.length <= 0) return null;

      const now = Date.now();
      const seededAgents: Agent[] = starterDrafts.map((draft, index) => ({
        id: `${packKey}-seed-${index + 1}`,
        name: draft.name,
        name_ko: draft.name_ko,
        name_ja: draft.name_ja,
        name_zh: draft.name_zh,
        department_id: draft.department_id,
        role: draft.role,
        acts_as_planning_leader: draft.acts_as_planning_leader,
        cli_provider: resolveOfficePackSeedProvider({
          packKey,
          departmentId: draft.department_id,
          role: draft.role,
          seedIndex: index + 1,
          seedOrderInDepartment: draft.seed_order_in_department,
        }),
        avatar_emoji: draft.avatar_emoji,
        sprite_number: draft.sprite_number,
        personality: draft.personality,
        status: "idle",
        current_task_id: null,
        created_at: now + index,
      }));

      return {
        departments: presentation.departments,
        agents: seededAgents,
        updated_at: now,
      };
    },
    [agents, customRoomThemes, departments],
  );

  const handleOfficeWorkflowPackChange = useCallback(
    (packKey: WorkflowPackKey) => {
      const previousPack = settings.officeWorkflowPack ?? "development";
      const previousProfiles = settings.officePackProfiles;
      const currentHydratedSet = readHydratedPackSet(settings);
      const shouldShowBootstrap = packKey !== "development" && !currentHydratedSet.has(packKey);
      const seedProfile = shouldShowBootstrap ? maybeBuildSeedProfileForPack(packKey, settings) : null;
      const nextOfficePackProfiles = seedProfile
        ? {
            ...(settings.officePackProfiles ?? {}),
            [packKey]: seedProfile,
          }
        : settings.officePackProfiles;
      const patchPayload: Record<string, unknown> = { officeWorkflowPack: packKey };
      if (seedProfile) {
        patchPayload.officePackProfiles = nextOfficePackProfiles;
      }
      const reqId = ++officePackBootstrapReqRef.current;
      if (shouldShowBootstrap) {
        setOfficePackBootstrappingLabel(getPackLabelByLanguage(packKey, settings.language));
      } else {
        setOfficePackBootstrappingLabel(null);
      }
      setSettings((prev) => ({
        ...prev,
        officeWorkflowPack: packKey,
        ...(seedProfile ? { officePackProfiles: nextOfficePackProfiles } : {}),
      }));
      api
        .saveSettingsPatch(patchPayload)
        .then(async () => {
          const [nextDepartments, nextAgents, nextSettingsRaw] = await Promise.all([
            api.getDepartments({ workflowPackKey: packKey }),
            api.getAgents({ includeSeed: packKey !== "development" }),
            api.getSettings(),
          ]);
          // Guard: only apply state if this is still the latest request
          if (officePackBootstrapReqRef.current !== reqId) return;
          setDepartments(nextDepartments);
          setAgents(nextAgents);
          setSettings(mergeSettingsWithDefaults(nextSettingsRaw));
          const clearNotice = () => {
            if (officePackBootstrapReqRef.current !== reqId) return;
            setOfficePackBootstrappingLabel(null);
          };
          if (shouldShowBootstrap) {
            setTimeout(clearNotice, 650);
          } else {
            clearNotice();
          }
        })
        .catch((error) => {
          console.error("Save office workflow pack failed:", error);
          if (officePackBootstrapReqRef.current === reqId) {
            setOfficePackBootstrappingLabel(null);
          }
          setSettings((prev) =>
            prev.officeWorkflowPack === packKey
              ? {
                  ...prev,
                  officeWorkflowPack: previousPack,
                  ...(seedProfile ? { officePackProfiles: previousProfiles } : {}),
                }
              : prev,
          );
        });
    },
    [maybeBuildSeedProfileForPack, setAgents, setDepartments, setSettings, settings],
  );

  return { officePackBootstrappingLabel, handleOfficeWorkflowPackChange };
}
