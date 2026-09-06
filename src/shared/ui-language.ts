/** The product UI supports English and German. User-authored content is unaffected. */
export type UiLanguage = "en" | "de";
export const SUPPORTED_UI_LANGUAGES = ["en", "de"] as const;

export function parseUiLanguage(value: unknown): UiLanguage | null {
  if (typeof value !== "string") return null;
  const code = value.trim().toLowerCase().replace("_", "-");
  if (code === "de" || code.startsWith("de-")) return "de";
  if (code === "en" || code.startsWith("en-")) return "en";
  return null;
}

export function normalizeUiLanguage(value: unknown): UiLanguage {
  return parseUiLanguage(value) ?? "en";
}
