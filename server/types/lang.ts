export type Lang = "ko" | "en" | "ja" | "zh" | "de";

const SUPPORTED_LANGS: readonly Lang[] = ["ko", "en", "ja", "zh", "de"] as const;

export function isLang(value: unknown): value is Lang {
  return typeof value === "string" && SUPPORTED_LANGS.includes(value as Lang);
}
