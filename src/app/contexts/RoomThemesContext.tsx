import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import type { Dispatch, MutableRefObject, ReactNode, SetStateAction } from "react";
import * as api from "../../api";
import type { RoomTheme } from "../../types";
import { ROOM_THEMES_STORAGE_KEY } from "../constants";
import type { RoomThemeMap } from "../types";
import { readStoredRoomThemes } from "../utils";

export interface RoomThemesContextValue {
  customRoomThemes: RoomThemeMap;
  setCustomRoomThemes: Dispatch<SetStateAction<RoomThemeMap>>;
  activeRoomThemeTargetId: string | null;
  setActiveRoomThemeTargetId: Dispatch<SetStateAction<string | null>>;
  hasLocalRoomThemesRef: MutableRefObject<boolean>;
  initialRoomThemes: { themes: RoomThemeMap; hasStored: boolean };
  handleRoomThemeChange: (themes: RoomThemeMap) => void;
}

const RoomThemesContext = createContext<RoomThemesContextValue | null>(null);

export interface RoomThemesProviderProps {
  children?: ReactNode;
}

export function RoomThemesProvider({ children }: RoomThemesProviderProps) {
  const initialRoomThemes = useMemo(() => readStoredRoomThemes(), []);
  const hasLocalRoomThemesRef = useRef<boolean>(initialRoomThemes.hasStored);
  const [customRoomThemes, setCustomRoomThemes] = useState<RoomThemeMap>(() => initialRoomThemes.themes);
  const [activeRoomThemeTargetId, setActiveRoomThemeTargetId] = useState<string | null>(null);

  const handleRoomThemeChange = useCallback((themes: RoomThemeMap) => {
    setCustomRoomThemes(themes);
    hasLocalRoomThemesRef.current = true;
    try {
      window.localStorage.setItem(ROOM_THEMES_STORAGE_KEY, JSON.stringify(themes));
    } catch {
      // ignore quota errors
    }
    api.saveRoomThemes(themes as Record<string, RoomTheme>).catch((error) => {
      console.error("Save room themes failed:", error);
    });
  }, []);

  const value = useMemo<RoomThemesContextValue>(
    () => ({
      customRoomThemes,
      setCustomRoomThemes,
      activeRoomThemeTargetId,
      setActiveRoomThemeTargetId,
      hasLocalRoomThemesRef,
      initialRoomThemes,
      handleRoomThemeChange,
    }),
    [customRoomThemes, activeRoomThemeTargetId, initialRoomThemes, handleRoomThemeChange],
  );

  return <RoomThemesContext.Provider value={value}>{children}</RoomThemesContext.Provider>;
}

export function useRoomThemes(): RoomThemesContextValue {
  const ctx = useContext(RoomThemesContext);
  if (!ctx) {
    throw new Error("useRoomThemes must be used within a RoomThemesProvider");
  }
  return ctx;
}
