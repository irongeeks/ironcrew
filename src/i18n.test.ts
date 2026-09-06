import { createElement } from "react";
import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  I18nProvider,
  detectBrowserLanguage,
  type I18nContextValue,
  localeFromLanguage,
  localeName,
  normalizeLanguage,
  pickLang,
  useI18n,
  LANGUAGE_STORAGE_KEY,
  SUPPORTED_UI_LANGUAGES,
} from "./i18n";
import { mergeSettingsWithDefaults, syncClientLanguage } from "./app/utils";

const ORIGINAL_LANGUAGE = window.navigator.language;
const ORIGINAL_LANGUAGES = window.navigator.languages;

describe("English and German UI languages", () => {
  afterEach(() => {
    Object.defineProperty(window.navigator, "language", { configurable: true, value: ORIGINAL_LANGUAGE });
    Object.defineProperty(window.navigator, "languages", { configurable: true, value: ORIGINAL_LANGUAGES });
    localStorage.removeItem(LANGUAGE_STORAGE_KEY);
    document.documentElement.lang = "en";
  });

  it("only supports English and German and normalizes regional variants", () => {
    expect(SUPPORTED_UI_LANGUAGES).toEqual(["en", "de"]);
    expect(normalizeLanguage(" DE_at ")).toBe("de");
    expect(normalizeLanguage("en_US")).toBe("en");
    for (const unsupported of ["ko-KR", "ja-JP", "zh-CN", "fr-FR", "", null, undefined]) {
      expect(normalizeLanguage(unsupported)).toBe("en");
    }
  });

  it("skips unsupported browser languages and finds the first supported preference", () => {
    Object.defineProperty(window.navigator, "languages", { configurable: true, value: ["ja-JP", "de-DE", "en-US"] });
    Object.defineProperty(window.navigator, "language", { configurable: true, value: "ko-KR" });
    expect(detectBrowserLanguage()).toBe("de");
    Object.defineProperty(window.navigator, "languages", { configurable: true, value: ["ja-JP"] });
    expect(detectBrowserLanguage()).toBe("en");
  });

  it("selects German with English fallback without selecting legacy translations", () => {
    const text = { en: "Hello", de: "Hallo", ko: "Legacy" };
    expect(pickLang("de", text)).toBe("Hallo");
    expect(pickLang("en", text)).toBe("Hello");
    expect(pickLang("de", { en: "Model" })).toBe("Model");
    const name = { name: "Planning", name_de: "Planung", name_ko: "Legacy" };
    expect(localeName("de-DE", name)).toBe("Planung");
    expect(localeName("ko", name)).toBe("Planning");
    expect(localeFromLanguage("de")).toBe("de-DE");
    expect(localeFromLanguage("en")).toBe("en-US");
  });

  it("keeps provider language, formatting and the document language aligned", () => {
    let result!: I18nContextValue;
    const Probe = ({ override }: { override?: string }) => {
      result = useI18n(override);
      return null;
    };
    const { rerender } = render(createElement(I18nProvider, { language: "de", children: createElement(Probe) }));
    expect(result.language).toBe("de");
    expect(result.locale).toBe("de-DE");
    expect(result.t({ en: "Save", de: "Speichern" })).toBe("Speichern");
    expect(document.documentElement.lang).toBe("de");
    rerender(createElement(I18nProvider, { language: "en", children: createElement(Probe) }));
    expect(result.language).toBe("en");
    expect(result.t({ en: "Save", de: "Speichern" })).toBe("Save");
    expect(document.documentElement.lang).toBe("en");
    rerender(createElement(I18nProvider, { language: "en", children: createElement(Probe, { override: "de-AT" }) }));
    expect(result.language).toBe("de");
  });

  it("persists runtime changes and normalizes unsupported settings before rendering", () => {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, "en");
    let result!: I18nContextValue;
    const Probe = () => {
      result = useI18n();
      return null;
    };
    render(createElement(Probe));
    act(() => syncClientLanguage("de-DE"));
    expect(result.language).toBe("de");
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe("de");
    expect(document.documentElement.lang).toBe("de");
    act(() => syncClientLanguage("ko"));
    expect(result.language).toBe("en");
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe("en");
    expect(mergeSettingsWithDefaults({ language: "ja" as never }).language).toBe("en");
  });
});
