import { useCallback } from "react";
import { useI18n } from "../i18n";

/** Source-owned UI copy that follows the active language without adding markup. */
export default function LocalizedText({ en, de }: { en: string; de: string }) {
  const { language } = useI18n();
  return language === "de" ? de : en;
}

export function useUiCopy() {
  const { language } = useI18n();
  return useCallback((en: string, de: string) => (language === "de" ? de : en), [language]);
}
