import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { readStoredValue } from "./storage";

export type UiLanguage = "ko" | "en" | "ja" | "zh" | "de";
export const LANGUAGE_STORAGE_KEY = "ironcrew.language";
export const LANGUAGE_USER_SET_STORAGE_KEY = "ironcrew.language.user_set";

export type LangText = {
  ko: string;
  en: string;
  ja?: string;
  zh?: string;
  de?: string;
};

type TranslationInput = LangText | string;

function parseLanguage(value?: string | null): UiLanguage | null {
  const code = (value ?? "").toLowerCase().replace("_", "-");
  if (code === "ko" || code.startsWith("ko-")) return "ko";
  if (code === "en" || code.startsWith("en-")) return "en";
  if (code === "ja" || code.startsWith("ja-")) return "ja";
  if (code === "zh" || code.startsWith("zh-")) return "zh";
  if (code === "de" || code.startsWith("de-")) return "de";
  return null;
}

export function normalizeLanguage(value?: string | null): UiLanguage {
  return parseLanguage(value) ?? "en";
}

/** Return locale-specific name, falling back to English (name) if empty */
export function localeName(
  locale: UiLanguage | string,
  obj: { name: string; name_ko?: string | null; name_ja?: string | null; name_zh?: string | null },
): string {
  const lang = (typeof locale === "string" ? locale : "en").slice(0, 2);
  if (lang === "ko") return obj.name_ko || obj.name;
  if (lang === "ja") return obj.name_ja || obj.name;
  if (lang === "zh") return obj.name_zh || obj.name;
  return obj.name;
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
  return parseLanguage(readStoredValue(LANGUAGE_STORAGE_KEY)) ?? detectBrowserLanguage();
}

export function localeFromLanguage(lang: UiLanguage): string {
  switch (lang) {
    case "ko":
      return "ko-KR";
    case "en":
      return "en-US";
    case "ja":
      return "ja-JP";
    case "zh":
      return "zh-CN";
    case "de":
      return "de-DE";
    default:
      return "en-US";
  }
}

export function pickLang(lang: UiLanguage, text: LangText): string {
  switch (lang) {
    case "ko":
      return text.ko;
    case "en":
      return text.en;
    case "ja":
      return text.ja ?? text.en;
    case "zh":
      return text.zh ?? text.en;
    case "de":
      return text.de ?? text.en;
    default:
      return text.en;
  }
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
