import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { readStoredValue } from "./storage";

import { normalizeUiLanguage, parseUiLanguage as parseLanguage, type UiLanguage } from "./shared/ui-language";
export { SUPPORTED_UI_LANGUAGES, type UiLanguage } from "./shared/ui-language";
export const LANGUAGE_STORAGE_KEY = "ironcrew.language";
export const LANGUAGE_USER_SET_STORAGE_KEY = "ironcrew.language.user_set";

export type LangText = {
  /** Older translation objects may retain these keys; they are never selected. */
  ko?: string;
  en: string;
  ja?: string;
  zh?: string;
  de?: string;
};

type TranslationInput = LangText | string;

export const normalizeLanguage = normalizeUiLanguage;

/** Return locale-specific name, falling back to English (name) if empty */
export function localeName(
  locale: UiLanguage | string,
  obj: {
    name: string;
    name_de?: string | null;
    name_ko?: string | null;
    name_ja?: string | null;
    name_zh?: string | null;
  },
): string {
  return normalizeLanguage(locale) === "de" ? obj.name_de || obj.name : obj.name;
}

export function detectBrowserLanguage(): UiLanguage {
  if (typeof window === "undefined") return "en";
  const candidates = [...(window.navigator.languages ?? []), window.navigator.language];
  for (const lang of candidates) {
    const parsed = parseLanguage(lang);
    if (parsed) return parsed;
  }
  return "en";
}

function detectRuntimeLanguage(): UiLanguage {
  if (typeof window === "undefined") return "en";
  const stored = readStoredValue(LANGUAGE_STORAGE_KEY);
  return stored ? normalizeLanguage(stored) : detectBrowserLanguage();
}

export function localeFromLanguage(lang: UiLanguage): string {
  return normalizeLanguage(lang) === "de" ? "de-DE" : "en-US";
}

export function pickLang(lang: UiLanguage, text: LangText): string {
  return normalizeLanguage(lang) === "de" ? (text.de ?? text.en) : text.en;
}

export interface I18nContextValue {
  language: UiLanguage;
  locale: string;
  t: (text: TranslationInput) => string;
  __fromProvider?: boolean;
}

const I18nContext = createContext<I18nContextValue>({
  language: "en",
  locale: "en-US",
  t: (text) => (typeof text === "string" ? text : text.en),
  __fromProvider: false,
});

interface I18nProviderProps {
  language?: string | null;
  children: ReactNode;
}

export function I18nProvider({ language, children }: I18nProviderProps) {
  const normalizedLanguage = normalizeLanguage(language);
  const locale = useMemo(() => localeFromLanguage(normalizedLanguage), [normalizedLanguage]);
  useEffect(() => {
    document.documentElement.lang = normalizedLanguage;
  }, [normalizedLanguage]);
  const t = useCallback(
    (text: TranslationInput) => (typeof text === "string" ? text : pickLang(normalizedLanguage, text)),
    [normalizedLanguage],
  );

  const value = useMemo(
    () => ({
      language: normalizedLanguage,
      locale,
      t,
      __fromProvider: true,
    }),
    [normalizedLanguage, locale, t],
  );

  return createElement(I18nContext.Provider, { value }, children);
}

export function useI18n(languageOverride?: string | null): I18nContextValue {
  const context = useContext(I18nContext);
  const [runtimeLanguage, setRuntimeLanguage] = useState<UiLanguage>(() => detectRuntimeLanguage());

  useEffect(() => {
    if (context.__fromProvider || typeof window === "undefined") return;
    const sync = () => {
      setRuntimeLanguage(detectRuntimeLanguage());
    };
    window.addEventListener("storage", sync);
    window.addEventListener("ironcrew-language-change", sync as EventListener);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener("ironcrew-language-change", sync as EventListener);
    };
  }, [context.__fromProvider]);

  const override = useMemo(() => {
    if (typeof languageOverride !== "string" || !languageOverride.trim()) return null;
    return normalizeLanguage(languageOverride);
  }, [languageOverride]);
  const baseLanguage = context.__fromProvider ? context.language : runtimeLanguage;
  const language = override ?? baseLanguage;

  const t = useCallback(
    (text: TranslationInput) => (typeof text === "string" ? text : pickLang(language, text)),
    [language],
  );

  return useMemo(
    () => ({
      language,
      locale: localeFromLanguage(language),
      t,
      __fromProvider: context.__fromProvider,
    }),
    [context.__fromProvider, language, t],
  );
}
