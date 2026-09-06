import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { browseProjectPath, getProjectPathSuggestions, isApiRequestError } from "../../api";
import type { FormFeedback, I18nTextMap, ManualPathEntry, MissingPathPrompt, ProjectI18nTranslate } from "./types";

interface UseProjectManagerPathToolsParams {
  t: ProjectI18nTranslate;
  projectPath: string;
  pathToolsVisible: boolean;
}

export interface ProjectManagerPathTools {
  pathSuggestionsOpen: boolean;
  setPathSuggestionsOpen: Dispatch<SetStateAction<boolean>>;
  pathSuggestionsLoading: boolean;
  pathSuggestions: string[];
  missingPathPrompt: MissingPathPrompt | null;
  setMissingPathPrompt: Dispatch<SetStateAction<MissingPathPrompt | null>>;
  manualPathPickerOpen: boolean;
  setManualPathPickerOpen: Dispatch<SetStateAction<boolean>>;
  nativePathPicking: boolean;
  setNativePathPicking: Dispatch<SetStateAction<boolean>>;
  manualPathLoading: boolean;
  manualPathCurrent: string;
  manualPathParent: string | null;
  manualPathEntries: ManualPathEntry[];
  manualPathTruncated: boolean;
  manualPathError: string | null;
  pathApiUnsupported: boolean;
  setPathApiUnsupported: Dispatch<SetStateAction<boolean>>;
  nativePickerUnsupported: boolean;
  setNativePickerUnsupported: Dispatch<SetStateAction<boolean>>;
  formFeedback: FormFeedback | null;
  setFormFeedback: Dispatch<SetStateAction<FormFeedback | null>>;
  unsupportedPathApiMessage: string;
  resolvePathHelperErrorMessage: (err: unknown, fallback: I18nTextMap) => string;
  resetPathHelperState: () => void;
  loadManualPathEntries: (targetPath?: string) => Promise<void>;
}

export function useProjectManagerPathTools({
  t,
  projectPath,
  pathToolsVisible,
}: UseProjectManagerPathToolsParams): ProjectManagerPathTools {
  const [pathSuggestionsOpen, setPathSuggestionsOpen] = useState(false);
  const [pathSuggestionsLoading, setPathSuggestionsLoading] = useState(false);
  const [pathSuggestions, setPathSuggestions] = useState<string[]>([]);
  const [missingPathPrompt, setMissingPathPrompt] = useState<MissingPathPrompt | null>(null);
  const [manualPathPickerOpen, setManualPathPickerOpen] = useState(false);
  const [nativePathPicking, setNativePathPicking] = useState(false);
  const [manualPathLoading, setManualPathLoading] = useState(false);
  const [manualPathCurrent, setManualPathCurrent] = useState("");
  const [manualPathParent, setManualPathParent] = useState<string | null>(null);
  const [manualPathEntries, setManualPathEntries] = useState<ManualPathEntry[]>([]);
  const [manualPathTruncated, setManualPathTruncated] = useState(false);
  const [manualPathError, setManualPathError] = useState<string | null>(null);
  const [pathApiUnsupported, setPathApiUnsupported] = useState(false);
  const [nativePickerUnsupported, setNativePickerUnsupported] = useState(false);
  const [formFeedback, setFormFeedback] = useState<FormFeedback | null>(null);

  const unsupportedPathApiMessage = useMemo(
    () =>
      t({
        en: "This server does not support path helper APIs. Enter the path manually.",
        de: "Dieser Server unterstützt keine Pfad-Hilfsfunktionen. Bitte den Pfad manuell eingeben.",
      }),
    [t],
  );

  const nativePickerUnavailableMessage = useMemo(
    () =>
      t({
        en: "OS folder picker is unavailable in this environment. Use in-app browser or manual input.",
        de: "Die Ordnerauswahl des Betriebssystems ist hier nicht verfügbar. Bitte den integrierten Dateibrowser oder die manuelle Eingabe verwenden.",
      }),
    [t],
  );

  const formatAllowedRootsMessage = useCallback(
    (allowedRoots: string[]) => {
      if (allowedRoots.length === 0) {
        return t({
          en: "Path is outside allowed project roots.",
          de: "Der Pfad liegt außerhalb der erlaubten Projektverzeichnisse.",
        });
      }
      return t({
        ko: `허용된 프로젝트 경로 범위를 벗어났습니다. 허용 경로: ${allowedRoots.join(", ")}`,
        en: `Path is outside allowed project roots. Allowed roots: ${allowedRoots.join(", ")}`,
        ja: `許可されたプロジェクトパス範囲外です。許可パス: ${allowedRoots.join(", ")}`,
        zh: `Path is outside allowed project roots. Allowed roots: ${allowedRoots.join(", ")}`,
        de: `Der Pfad liegt außerhalb der erlaubten Projektverzeichnisse. Erlaubte Verzeichnisse: ${allowedRoots.join(", ")}`,
      });
    },
    [t],
  );

  const resolvePathHelperErrorMessage = useCallback(
    (err: unknown, fallback: I18nTextMap) => {
      if (!isApiRequestError(err)) return t(fallback);
      if (err.status === 404) {
        return unsupportedPathApiMessage;
      }
      if (err.code === "project_path_outside_allowed_roots") {
        const allowedRoots = Array.isArray((err.details as { allowed_roots?: unknown })?.allowed_roots)
          ? (err.details as { allowed_roots: unknown[] }).allowed_roots.filter(
              (item): item is string => typeof item === "string" && item.trim().length > 0,
            )
          : [];
        return formatAllowedRootsMessage(allowedRoots);
      }
      if (err.code === "native_picker_unavailable" || err.code === "native_picker_failed") {
        return nativePickerUnavailableMessage;
      }
      if (err.code === "project_path_not_directory") {
        return t({
          en: "This path is not a directory. Please enter a directory path.",
          de: "Dieser Pfad ist kein Verzeichnis. Bitte einen Verzeichnispfad eingeben.",
        });
      }
      if (err.code === "project_path_not_found") {
        return t({ en: "Path not found.", de: "Pfad nicht gefunden." });
      }
      return t(fallback);
    },
    [formatAllowedRootsMessage, nativePickerUnavailableMessage, t, unsupportedPathApiMessage],
  );

  const resetPathHelperState = useCallback(() => {
    setPathSuggestionsOpen(false);
    setPathSuggestionsLoading(false);
    setPathSuggestions([]);
    setMissingPathPrompt(null);
    setManualPathPickerOpen(false);
    setNativePathPicking(false);
    setManualPathLoading(false);
    setManualPathCurrent("");
    setManualPathParent(null);
    setManualPathEntries([]);
    setManualPathTruncated(false);
    setManualPathError(null);
    setPathApiUnsupported(false);
    setNativePickerUnsupported(false);
    setFormFeedback(null);
  }, []);

  useEffect(() => {
    if (pathToolsVisible) return;
    resetPathHelperState();
  }, [pathToolsVisible, resetPathHelperState]);

  useEffect(() => {
    if (!pathToolsVisible || !pathSuggestionsOpen || pathApiUnsupported) return;
    let cancelled = false;
    setPathSuggestionsLoading(true);
    getProjectPathSuggestions(projectPath.trim(), 30)
      .then((paths) => {
        if (cancelled) return;
        setPathSuggestions(paths);
      })
      .catch((err) => {
        console.error("Failed to load project path suggestions:", err);
        if (cancelled) return;
        if (isApiRequestError(err) && err.status === 404) {
          setPathApiUnsupported(true);
          setPathSuggestionsOpen(false);
          setFormFeedback({ tone: "info", message: unsupportedPathApiMessage });
          return;
        }
        setPathSuggestions([]);
        setFormFeedback({
          tone: "error",
          message: resolvePathHelperErrorMessage(err, {
            en: "Failed to load path suggestions.",
            de: "Die Pfadvorschläge konnten nicht geladen werden.",
          }),
        });
      })
      .finally(() => {
        if (cancelled) return;
        setPathSuggestionsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    pathApiUnsupported,
    pathSuggestionsOpen,
    pathToolsVisible,
    projectPath,
    resolvePathHelperErrorMessage,
    unsupportedPathApiMessage,
  ]);

  const loadManualPathEntries = useCallback(
    async (targetPath?: string) => {
      if (pathApiUnsupported) {
        setManualPathError(unsupportedPathApiMessage);
        return;
      }
      setManualPathLoading(true);
      setManualPathError(null);
      try {
        const result = await browseProjectPath(targetPath);
        setManualPathCurrent(result.current_path);
        setManualPathParent(result.parent_path);
        setManualPathEntries(result.entries);
        setManualPathTruncated(result.truncated);
      } catch (err) {
        console.error("Failed to browse project path:", err);
        if (isApiRequestError(err) && err.status === 404) {
          setPathApiUnsupported(true);
          setManualPathPickerOpen(false);
          setManualPathError(unsupportedPathApiMessage);
          setFormFeedback({ tone: "info", message: unsupportedPathApiMessage });
        } else {
          setManualPathError(
            resolvePathHelperErrorMessage(err, {
              en: "Failed to load directories.",
              de: "Die Verzeichnisse konnten nicht geladen werden.",
            }),
          );
        }
        setManualPathEntries([]);
        setManualPathTruncated(false);
      } finally {
        setManualPathLoading(false);
      }
    },
    [pathApiUnsupported, resolvePathHelperErrorMessage, unsupportedPathApiMessage],
  );

  return {
    pathSuggestionsOpen,
    setPathSuggestionsOpen,
    pathSuggestionsLoading,
    pathSuggestions,
    missingPathPrompt,
    setMissingPathPrompt,
    manualPathPickerOpen,
    setManualPathPickerOpen,
    nativePathPicking,
    setNativePathPicking,
    manualPathLoading,
    manualPathCurrent,
    manualPathParent,
    manualPathEntries,
    manualPathTruncated,
    manualPathError,
    pathApiUnsupported,
    setPathApiUnsupported,
    nativePickerUnsupported,
    setNativePickerUnsupported,
    formFeedback,
    setFormFeedback,
    unsupportedPathApiMessage,
    resolvePathHelperErrorMessage,
    resetPathHelperState,
    loadManualPathEntries,
  };
}
