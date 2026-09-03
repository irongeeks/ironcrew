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
    ko: "OctoOffice 로딩 중...",
    en: "Loading OctoOffice...",
    ja: "OctoOfficeを読み込み中...",
    zh: "Loading OctoOffice...",
    de: "OctoOffice wird geladen...",
  });
  const loadingSubtitle = pickLang(uiLanguage, {
    ko: "AI 에이전트 오피스를 준비하고 있습니다",
    en: "Preparing your AI agent office",
    ja: "AIエージェントオフィスを準備しています",
    zh: "正在准备你的 AI 智能体办公室",
    de: "Dein KI-Agenten-Office wird vorbereitet",
  });
  const viewTitle = (() => {
    switch (view) {
      case "office":
        return `🏢 ${pickLang(uiLanguage, {
          ko: "오피스",
          en: "Office",
          ja: "オフィス",
          zh: "Office",
          de: "Büro",
        })}`;
      case "operations":
        return `⚡ ${pickLang(uiLanguage, {
          ko: "운영 센터",
          en: "Operations",
          ja: "オペレーション",
          zh: "Operations",
          de: "Betrieb",
        })}`;
      case "tasks":
        return `📋 ${pickLang(uiLanguage, {
          ko: "업무 관리",
          en: "Tasks",
          ja: "タスク管理",
          zh: "Tasks",
          de: "Aufgaben",
        })}`;
      case "agents":
        return `${pickLang(uiLanguage, {
          ko: "직원관리",
          en: "Agents",
          ja: "社員管理",
          zh: "Agents",
          de: "Agenten",
        })}`;
      case "skills":
        return `📚 ${pickLang(uiLanguage, {
          ko: "문서고",
          en: "Skills",
          ja: "スキル資料室",
          zh: "Skills",
          de: "Skills",
        })}`;
      case "settings":
        return `⚙️ ${pickLang(uiLanguage, {
          ko: "설정",
          en: "Settings",
          ja: "設定",
          zh: "Settings",
          de: "Einstellungen",
        })}`;
      default:
        return "";
    }
  })();
  const announcementLabel = `📢 ${pickLang(uiLanguage, {
    ko: "전사 공지",
    en: "Announcement",
    ja: "全社告知",
    zh: "Announcement",
    de: "Ankündigung",
  })}`;
  const roomManagerLabel = `🏢 ${pickLang(uiLanguage, {
    ko: "사무실 관리",
    en: "Office Manager",
    ja: "オフィス管理",
    zh: "Office Manager",
    de: "Büroverwaltung",
  })}`;
  const roomManagerDepartments = useMemo(
    () => [
      {
        id: "ceoOffice",
        name: pickLang(uiLanguage, {
          ko: "CEO 오피스",
          en: "CEO Office",
          ja: "CEOオフィス",
          zh: "CEO Office",
          de: "CEO-Büro",
        }),
      },
      ...departments,
      {
        id: "breakRoom",
        name: pickLang(uiLanguage, {
          ko: "휴게실",
          en: "Break Room",
          ja: "休憩室",
          zh: "Break Room",
          de: "Pausenraum",
        }),
      },
    ],
    [departments, uiLanguage],
  );
  const reportLabel = `📋 ${pickLang(uiLanguage, {
    ko: "보고서",
    en: "Reports",
    ja: "レポート",
    zh: "Reports",
    de: "Berichte",
  })}`;
  const tasksPrimaryLabel = pickLang(uiLanguage, {
    ko: "업무",
    en: "Tasks",
    ja: "タスク",
    zh: "Tasks",
    de: "Aufgaben",
  });
  const agentStatusLabel = pickLang(uiLanguage, {
    ko: "에이전트",
    en: "Agents",
    ja: "エージェント",
    zh: "Agents",
    de: "Agenten",
  });
  const decisionLabel = pickLang(uiLanguage, {
    ko: "의사결정",
    en: "Decisions",
    ja: "意思決定",
    zh: "Decisions",
    de: "Entscheidungen",
  });
  const effectiveUpdateStatus = forceUpdateBanner
    ? {
        current_version: updateStatus?.current_version ?? "1.1.0",
        latest_version: updateStatus?.latest_version ?? "1.1.1-test",
        update_available: true,
        release_url: updateStatus?.release_url ?? "https://github.com/Chepko932/OctoOffice/releases/latest",
        checked_at: Date.now(),
        enabled: true,
        repo: updateStatus?.repo ?? "Chepko932/OctoOffice",
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
    `https://github.com/${effectiveUpdateStatus?.repo ?? "Chepko932/OctoOffice"}/releases/latest`;
  const updateTitle = updateBannerVisible
    ? pickLang(uiLanguage, {
        ko: `새 버전 v${effectiveUpdateStatus?.latest_version} 사용 가능 (현재 v${effectiveUpdateStatus?.current_version}).`,
        en: `New version v${effectiveUpdateStatus?.latest_version} is available (current v${effectiveUpdateStatus?.current_version}).`,
        ja: `新しいバージョン v${effectiveUpdateStatus?.latest_version} が利用可能です（現在 v${effectiveUpdateStatus?.current_version}）。`,
        zh: `New version v${effectiveUpdateStatus?.latest_version} is available (current v${effectiveUpdateStatus?.current_version}).`,
        de: `Neue Version v${effectiveUpdateStatus?.latest_version} verfügbar (aktuell v${effectiveUpdateStatus?.current_version}).`,
      })
    : "";
  const updateHint =
    runtimeOs === "windows"
      ? pickLang(uiLanguage, {
          ko: "Windows PowerShell에서 `git pull; pnpm install` 실행 후 서버를 재시작하세요.",
          en: "In Windows PowerShell, run `git pull; pnpm install`, then restart the server.",
          ja: "Windows PowerShell で `git pull; pnpm install` を実行し、サーバーを再起動してください。",
          zh: "In Windows PowerShell, run `git pull; pnpm install`, then restart the server.",
          de: "In Windows PowerShell `git pull; pnpm install` ausführen und dann den Server neu starten.",
        })
      : pickLang(uiLanguage, {
          ko: "macOS/Linux에서 `git pull && pnpm install` 실행 후 서버를 재시작하세요.",
          en: "On macOS/Linux, run `git pull && pnpm install`, then restart the server.",
          ja: "macOS/Linux で `git pull && pnpm install` を実行し、サーバーを再起動してください。",
          zh: "On macOS/Linux, run `git pull && pnpm install`, then restart the server.",
          de: "Auf macOS/Linux `git pull && pnpm install` ausführen und dann den Server neu starten.",
        });
  const updateReleaseLabel = pickLang(uiLanguage, {
    ko: "릴리즈 노트",
    en: "Release Notes",
    ja: "リリースノート",
    zh: "Release Notes",
    de: "Release Notes",
  });
  const updateDismissLabel = pickLang(uiLanguage, {
    ko: "나중에",
    en: "Dismiss",
    ja: "後で",
    zh: "Dismiss",
    de: "Schließen",
  });
  const autoUpdateNoticeVisible = Boolean(settings.autoUpdateNoticePending);
  const autoUpdateNoticeTitle = pickLang(uiLanguage, {
    ko: "업데이트 안내: 자동 업데이트 토글이 추가되었습니다.",
    en: "Update notice: Auto Update toggle has been added.",
    ja: "更新のお知らせ: Auto Update トグルが追加されました。",
    zh: "Update notice: Auto Update toggle has been added.",
    de: "Update-Hinweis: Ein Auto-Update-Schalter wurde hinzugefügt.",
  });
  const autoUpdateNoticeHint = pickLang(uiLanguage, {
    ko: "기존 설치(1.1.3 이하)에서는 기본값이 OFF입니다. Settings > General에서 필요 시 ON으로 전환할 수 있습니다.",
    en: "For existing installs (v1.1.3 and below), the default remains OFF. You can enable it in Settings > General when needed.",
    ja: "既存インストール（v1.1.3 以下）では既定値は OFF のままです。必要に応じて Settings > General で ON にできます。",
    zh: "For existing installs (v1.1.3 and below), the default remains OFF. You can enable it in Settings > General when needed.",
    de: "Bei bestehenden Installationen (v1.1.3 und älter) bleibt der Standard auf AUS. Bei Bedarf unter Settings > General aktivieren.",
  });
  const autoUpdateNoticeActionLabel = pickLang(uiLanguage, {
    ko: "확인",
    en: "Got it",
    ja: "確認",
    zh: "Got it",
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
        ko: "테스트 표시 모드입니다. `?force_update_banner=1`을 제거하면 원래 상태로 돌아갑니다.",
        en: "Test display mode is on. Remove `?force_update_banner=1` to return to normal behavior.",
        ja: "テスト表示モードです。`?force_update_banner=1` を外すと通常動作に戻ります。",
        zh: "Test display mode is on. Remove `?force_update_banner=1` to return to normal behavior.",
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
