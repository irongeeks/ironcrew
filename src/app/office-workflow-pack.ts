export type {
  UiLanguageLike,
  Localized,
  DeptPreset,
  StaffPreset,
  SeedProfile,
  PackPreset,
  OfficePackPresentation,
  OfficePackStarterAgentDraft,
  OfficePackSeedProvider,
} from "./office-pack-presets";
export { OFFICE_SEED_SPRITE_POOL, DEV_THEMES, PACK_SEED_PROFILE, PACK_PRESETS } from "./office-pack-presets";

export { PACK_NAME_POOL_OVERRIDES, DEPARTMENT_PERSON_NAME_POOL } from "./office-pack-name-pools";

export {
  pickText,
  localizedNumberedName,
  localizedStaffDisplayName,
  buildSeedPersonality,
  buildPackDepartmentDescription,
  buildPackDepartmentPrompt,
} from "./office-pack-localization";

export { resolveOfficePackSeedProvider, buildOfficePackStarterAgents } from "./office-pack-seed";

export {
  buildPresetFromRegistryEntry,
  buildNamePoolFromRegistry,
  mergeRegistryIntoPresets,
  mergeNamePoolOverrides,
  normalizeOfficeWorkflowPack,
  getOfficePackMeta,
  getOfficePackRoomThemes,
  listOfficePackOptions,
  buildOfficePackPresentation,
} from "./office-pack-registry";
