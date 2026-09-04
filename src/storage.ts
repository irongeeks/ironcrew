/**
 * Guarded access to the browser-local preferences that survived the rename to
 * IronCrew.
 *
 * Two things happen here that every call site would otherwise have to repeat.
 * First, every access is wrapped: a browser in private mode, or one configured
 * to block site data, throws on `localStorage` itself, and a preference we
 * cannot read is not an error worth propagating. Second, a value written under
 * a key's pre-rename name is adopted the first time we look for it, so nobody
 * loses a setting to a product rename.
 */

/**
 * The pre-rename spelling of each key we still migrate from.
 *
 * These are deliberately the old brand's names: they are not leftover branding
 * but the only trace of it a returning user's browser still holds. Once a value
 * moves across it is removed, so an entry here stops mattering for that person
 * forever after; the table can be dropped entirely a release or two after
 * everyone has opened the app again.
 */
const PREVIOUS_KEY_BY_KEY: Readonly<Record<string, string>> = {
  ironcrew_theme: "octooffice_theme",
  "ironcrew.language": "octooffice.language",
  "ironcrew.language.user_set": "octooffice.language.user_set",
  "ironcrew.taskCreateDrafts": "octooffice.taskCreateDrafts",
  ironcrew_room_themes: "octooffice_room_themes",
  ironcrew_update_banner_dismissed: "octooffice_update_banner_dismissed",
};

/**
 * Reads the new key, falling back once to the pre-rename key.
 *
 * The rename would otherwise silently discard a setting the person chose: they
 * would open the app after an update and find their theme reset, with nothing
 * to tell them why. Reading the old key once and writing the new one migrates
 * it invisibly; the old key is removed so this is not load-bearing forever.
 */
function readRenamedValue(nextKey: string, previousKey: string): string | null {
  try {
    const current = window.localStorage.getItem(nextKey);
    if (current !== null) return current;
    const legacy = window.localStorage.getItem(previousKey);
    if (legacy === null) return null;
    window.localStorage.setItem(nextKey, legacy);
    window.localStorage.removeItem(previousKey);
    return legacy;
  } catch {
    // Private mode, blocked site data: a missing preference is not an error.
    return null;
  }
}

/**
 * Reads one stored value, migrating it from its pre-rename key if that is where
 * it still lives. Returns null when there is nothing stored, or when the
 * browser refuses to hand out storage at all.
 */
export function readStoredValue(key: string): string | null {
  if (typeof window === "undefined") return null;
  const previousKey = PREVIOUS_KEY_BY_KEY[key];
  if (previousKey) return readRenamedValue(key, previousKey);
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * Writes one stored value under its current key. Failure is silent on purpose:
 * a full quota or a browser that blocks storage should not break the action the
 * user actually asked for, it should only cost them the persistence of it.
 */
export function writeStoredValue(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Quota exceeded or storage blocked: the in-memory state is still correct.
  }
}
