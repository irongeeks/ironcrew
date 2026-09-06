import { useCallback, useMemo } from "react";
import { isApiRequestError } from "../../../api";
import type { LangText } from "../../../i18n";
import type { TFunction } from "../constants";

export function usePathHelperMessages(t: TFunction) {
  const unsupportedPathApiMessage = useMemo(
    () =>
      t({
        en: "This server does not support path helper APIs. Enter the path manually.",
        de: "Dieser Server unterstützt keine Pfadhilfe-APIs. Bitte den Pfad manuell eingeben.",
      }),
    [t],
  );

  const nativePickerUnavailableMessage = useMemo(
    () =>
      t({
        en: "OS folder picker is unavailable in this environment. Use in-app browser or manual input.",
        de: "OS-Ordnerauswahl ist in dieser Umgebung nicht verfügbar. Bitte den Ordner-Browser oder manuelle Eingabe verwenden.",
      }),
    [t],
  );

  const formatAllowedRootsMessage = useCallback(
    (allowedRoots: string[]) => {
      if (allowedRoots.length === 0) {
        return t({
          en: "Path is outside allowed project roots.",
          de: "Pfad liegt außerhalb der erlaubten Projektstammpfade.",
        });
      }
      return t({
        ko: `허용된 프로젝트 경로 범위를 벗어났습니다. 허용 경로: ${allowedRoots.join(", ")}`,
        en: `Path is outside allowed project roots. Allowed roots: ${allowedRoots.join(", ")}`,
        ja: `許可されたプロジェクトパス範囲外です。許可パス: ${allowedRoots.join(", ")}`,
        zh: `Path is outside allowed project roots. Allowed roots: ${allowedRoots.join(", ")}`,
        de: `Pfad liegt außerhalb der erlaubten Projektstammpfade. Erlaubte Stammpfade: ${allowedRoots.join(", ")}`,
      });
    },
    [t],
  );

  const resolvePathHelperErrorMessage = useCallback(
    (error: unknown, fallback: LangText) => {
      if (!isApiRequestError(error)) return t(fallback);

      if (error.status === 404) {
        return unsupportedPathApiMessage;
      }
      if (error.code === "project_path_outside_allowed_roots") {
        const allowedRoots = Array.isArray((error.details as { allowed_roots?: unknown })?.allowed_roots)
          ? (error.details as { allowed_roots: unknown[] }).allowed_roots.filter(
              (item): item is string => typeof item === "string" && item.trim().length > 0,
            )
          : [];
        return formatAllowedRootsMessage(allowedRoots);
      }
      if (error.code === "native_picker_unavailable" || error.code === "native_picker_failed") {
        return nativePickerUnavailableMessage;
      }
      if (error.code === "project_path_not_directory") {
        return t({
          en: "This path is not a directory. Please enter a directory path.",
          de: "Dieser Pfad ist kein Verzeichnis. Bitte einen Verzeichnispfad eingeben.",
        });
      }
      if (error.code === "project_path_not_found") {
        return t({ en: "Path not found.", de: "Pfad nicht gefunden." });
      }
      return t(fallback);
    },
    [formatAllowedRootsMessage, nativePickerUnavailableMessage, t, unsupportedPathApiMessage],
  );

  return {
    unsupportedPathApiMessage,
    nativePickerUnavailableMessage,
    resolvePathHelperErrorMessage,
  };
}
