import { NAVIGATION_LABELS } from "./navigation-labels";
import { useMemo } from "react";
import type * as api from "../api";
import { normalizeLanguage, pickLang } from "../i18n";
import type { CompanySettings, Department } from "../types";
import type { RuntimeOs, View } from "./types";

interface UseAppLabelsParams {
  view: View;
  settings: CompanySettings;
  departments: Department[];
  theme: "light" | "dark";
  runtimeOs: RuntimeOs;
  forceUpdateBanner: boolean;
  updateStatus: api.UpdateStatus | null;
  dismissedUpdateVersion: string;
}

export function useAppLabels({
  view,
  settings,
  departments,
  theme,
  runtimeOs,
  forceUpdateBanner,
  updateStatus,
  dismissedUpdateVersion,
}: UseAppLabelsParams) {
  const uiLanguage = normalizeLanguage(settings.language);
  const loadingTitle = pickLang(uiLanguage, {
    en: "Loading IronCrew...",
    de: "IronCrew wird geladen...",
  });
  const loadingSubtitle = pickLang(uiLanguage, {
    en: "Preparing your AI agent office",
    de: "Dein Büro für KI-Agenten wird vorbereitet",
  });
  const viewTitle =
    view in NAVIGATION_LABELS ? pickLang(uiLanguage, NAVIGATION_LABELS[view as keyof typeof NAVIGATION_LABELS]) : "";
  const announcementLabel = `📢 ${pickLang(uiLanguage, {
    en: "Announcement",
    de: "Ankündigung",
  })}`;
  const roomManagerLabel = `🏢 ${pickLang(uiLanguage, {
    en: "Office Manager",
    de: "Büroverwaltung",
  })}`;
  const roomManagerDepartments = useMemo(
    () => [
      {
        id: "ceoOffice",
        name: pickLang(uiLanguage, {
          en: "CEO Office",
          de: "CEO-Büro",
        }),
      },
      ...departments,
      {
        id: "breakRoom",
        name: pickLang(uiLanguage, {
          en: "Break Room",
          de: "Pausenraum",
        }),
      },
    ],
    [departments, uiLanguage],
  );
  const reportLabel = `📋 ${pickLang(uiLanguage, {
    en: "Reports",
    de: "Berichte",
  })}`;
  const tasksPrimaryLabel = pickLang(uiLanguage, {
    en: "Tasks",
    de: "Aufgaben",
  });
  const agentStatusLabel = pickLang(uiLanguage, {
    en: "Agents",
    de: "Agenten",
  });
  const decisionLabel = pickLang(uiLanguage, {
    en: "Decisions",
    de: "Entscheidungen",
  });
  const effectiveUpdateStatus = forceUpdateBanner
    ? {
        current_version: updateStatus?.current_version ?? "1.1.0",
        latest_version: updateStatus?.latest_version ?? "1.1.1-test",
        update_available: true,
        release_url: updateStatus?.release_url ?? "https://github.com/irongeeks/ironcrew/releases/latest",
        checked_at: Date.now(),
        enabled: true,
        repo: updateStatus?.repo ?? "irongeeks/ironcrew",
        error: null,
      }
    : updateStatus;
  const updateBannerVisible = Boolean(
    effectiveUpdateStatus?.enabled &&
    effectiveUpdateStatus.update_available &&
    effectiveUpdateStatus.latest_version &&
    (forceUpdateBanner || effectiveUpdateStatus.latest_version !== dismissedUpdateVersion),
  );
  const updateReleaseUrl =
    effectiveUpdateStatus?.release_url ??
    `https://github.com/${effectiveUpdateStatus?.repo ?? "irongeeks/ironcrew"}/releases/latest`;
  const updateTitle = updateBannerVisible
    ? pickLang(uiLanguage, {
        en: `New version v${effectiveUpdateStatus?.latest_version} is available (current v${effectiveUpdateStatus?.current_version}).`,
        de: `Neue Version v${effectiveUpdateStatus?.latest_version} verfügbar (aktuell v${effectiveUpdateStatus?.current_version}).`,
      })
    : "";
  const updateHint =
    runtimeOs === "windows"
      ? pickLang(uiLanguage, {
          en: "In Windows PowerShell, run `git pull; pnpm install`, then restart the server.",
          de: "In Windows PowerShell `git pull; pnpm install` ausführen und dann den Server neu starten.",
        })
      : pickLang(uiLanguage, {
          en: "On macOS/Linux, run `git pull && pnpm install`, then restart the server.",
          de: "Auf macOS/Linux `git pull && pnpm install` ausführen und dann den Server neu starten.",
        });
  const updateReleaseLabel = pickLang(uiLanguage, {
    en: "Release Notes",
    de: "Versionshinweise",
  });
  const updateDismissLabel = pickLang(uiLanguage, {
    en: "Dismiss",
    de: "Schließen",
  });
  const autoUpdateNoticeVisible = Boolean(settings.autoUpdateNoticePending);
  const autoUpdateNoticeTitle = pickLang(uiLanguage, {
    en: "Update notice: Auto Update toggle has been added.",
    de: "Update-Hinweis: Ein Auto-Update-Schalter wurde hinzugefügt.",
  });
  const autoUpdateNoticeHint = pickLang(uiLanguage, {
    en: "You can enable automatic updates in Settings > General.",
    de: "Du kannst automatische Updates unter Einstellungen > Allgemein aktivieren.",
  });
  const autoUpdateNoticeActionLabel = pickLang(uiLanguage, {
    en: "Got it",
    de: "Verstanden",
  });
  const autoUpdateNoticeContainerClass =
    theme === "light"
      ? "border-b border-sky-200 bg-sky-50 px-3 py-2.5 sm:px-4 lg:px-6"
      : "border-b border-sky-500/30 bg-sky-500/10 px-3 py-2.5 sm:px-4 lg:px-6";
  const autoUpdateNoticeTextClass = theme === "light" ? "min-w-0 text-xs text-sky-900" : "min-w-0 text-xs text-sky-100";
  const autoUpdateNoticeHintClass =
    theme === "light" ? "mt-0.5 text-[11px] text-sky-800" : "mt-0.5 text-[11px] text-sky-200/90";
  const autoUpdateNoticeButtonClass =
    theme === "light"
      ? "rounded-md border border-sky-300 bg-white px-2.5 py-1 text-[11px] text-sky-900 transition hover:bg-sky-100"
      : "rounded-md border border-sky-300/40 bg-sky-200/10 px-2.5 py-1 text-[11px] text-sky-100 transition hover:bg-sky-200/20";
  const updateTestModeHint = forceUpdateBanner
    ? pickLang(uiLanguage, {
        en: "Test display mode is on. Remove `?force_update_banner=1` to return to normal behavior.",
        de: "Testanzeigemodus ist aktiv. Entferne `?force_update_banner=1`, um zum Normalbetrieb zurückzukehren.",
      })
    : "";

  return {
    uiLanguage,
    loadingTitle,
    loadingSubtitle,
    viewTitle,
    announcementLabel,
    roomManagerLabel,
    roomManagerDepartments,
    reportLabel,
    tasksPrimaryLabel,
    agentStatusLabel,
    decisionLabel,
    effectiveUpdateStatus,
    updateBannerVisible,
    updateReleaseUrl,
    updateTitle,
    updateHint,
    updateReleaseLabel,
    updateDismissLabel,
    autoUpdateNoticeVisible,
    autoUpdateNoticeTitle,
    autoUpdateNoticeHint,
    autoUpdateNoticeActionLabel,
    autoUpdateNoticeContainerClass,
    autoUpdateNoticeTextClass,
    autoUpdateNoticeHintClass,
    autoUpdateNoticeButtonClass,
    updateTestModeHint,
  };
}
