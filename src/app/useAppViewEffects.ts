import { useEffect } from "react";

import * as api from "../api";
import type { CliStatusMap, MeetingPresence } from "../types";
import type { OAuthCallbackResult, View } from "./types";

type UseAppViewEffectsParams = {
  view: View;
  cliStatus: CliStatusMap | null;
  setView: (next: View) => void;
  setOauthResult: (next: OAuthCallbackResult | null) => void;
  setCliStatus: (next: CliStatusMap | null) => void;
  setMobileNavOpen: (next: boolean) => void;
  setMeetingPresence: (next: MeetingPresence[]) => void;
};

export function useAppViewEffects({
  view,
  cliStatus,
  setView,
  setOauthResult,
  setCliStatus,
  setMobileNavOpen,
  setMeetingPresence,
}: UseAppViewEffectsParams): void {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const oauthProvider = params.get("oauth");
    const oauthError = params.get("oauth_error");
    if (oauthProvider || oauthError) {
      setOauthResult({ provider: oauthProvider, error: oauthError });
      const clean = new URL(window.location.href);
      clean.searchParams.delete("oauth");
      clean.searchParams.delete("oauth_error");
      window.history.replaceState({}, "", clean.pathname + clean.search);
      setView("settings");
    }
  }, [setOauthResult, setView]);

  useEffect(() => {
    if (view === "settings" && !cliStatus) {
      api.getCliStatus(true).then(setCliStatus).catch(console.error);
    }
  }, [view, cliStatus, setCliStatus]);

  useEffect(() => {
    setMobileNavOpen(false);
  }, [view, setMobileNavOpen]);

  useEffect(() => {
    const closeMobileNavOnDesktop = () => {
      if (window.innerWidth >= 1024) setMobileNavOpen(false);
    };
    window.addEventListener("resize", closeMobileNavOnDesktop);
    return () => window.removeEventListener("resize", closeMobileNavOnDesktop);
  }, [setMobileNavOpen]);

  useEffect(() => {
    if (view !== "office") return;
    api
      .getMeetingPresence()
      .then(setMeetingPresence)
      .catch(() => {
        // keep UI responsive even if meeting-presence endpoint is temporarily unavailable
      });
  }, [view, setMeetingPresence]);
}
