import { useCallback, useEffect, useRef, useState } from "react";
import { isApiRequestError, listDiscordChannelsByToken } from "../../../api";
import type { DiscordDiscoverableChannel } from "../../../api";
import type { ChannelSettingsTabProps } from "../types";
import type { MessengerChannelType } from "../../../types";

type UseDiscordChannelLookupInput = {
  editorOpen: boolean;
  editorChannel: MessengerChannelType;
  editorToken: string;
  t: ChannelSettingsTabProps["t"];
};

function resolveDiscordLookupErrorMessage(t: ChannelSettingsTabProps["t"], error: unknown): string {
  if (isApiRequestError(error)) {
    const code = error.code ?? "";
    if (code === "discord_token_required") {
      return t({ en: "Please enter a Discord token.", de: "Bitte geben Sie einen Discord-Token ein." });
    }
    if (code === "discord_auth_failed") {
      return t({
        en: "Discord authentication failed. Check your bot token and permissions.",
        de: "Discord-Authentifizierung fehlgeschlagen. Bitte Bot-Token und Berechtigungen prüfen.",
      });
    }
    if (code === "discord_rate_limited") {
      return t({
        en: "Discord API is rate-limited. Please try again shortly.",
        de: "Discord API ist durch Rate-Limiting eingeschränkt. Bitte versuchen Sie es in Kürze erneut.",
      });
    }
    if (code === "discord_channel_lookup_failed") {
      return t({
        en: "Failed to load Discord channels. Check network connectivity and permissions.",
        de: "Discord-Kanäle konnten nicht geladen werden. Bitte Netzwerkverbindung und Berechtigungen prüfen.",
      });
    }
  }
  return t({
    en: "An error occurred while loading Discord channels.",
    de: "Beim Laden der Discord-Kanäle ist ein Fehler aufgetreten.",
  });
}

export function useDiscordChannelLookup({ editorOpen, editorChannel, editorToken, t }: UseDiscordChannelLookupInput) {
  const [discordChannelsLoading, setDiscordChannelsLoading] = useState(false);
  const [discordChannelOptions, setDiscordChannelOptions] = useState<DiscordDiscoverableChannel[]>([]);
  const [discordChannelsError, setDiscordChannelsError] = useState<string | null>(null);
  const discordLookupSeq = useRef(0);

  const resolveError = useCallback((error: unknown): string => resolveDiscordLookupErrorMessage(t, error), [t]);

  useEffect(() => {
    if (!editorOpen || editorChannel !== "discord") {
      setDiscordChannelsLoading(false);
      setDiscordChannelsError(null);
      setDiscordChannelOptions([]);
      return;
    }
    const token = editorToken.trim();
    if (!token) {
      setDiscordChannelsLoading(false);
      setDiscordChannelsError(null);
      setDiscordChannelOptions([]);
      return;
    }

    const seq = discordLookupSeq.current + 1;
    discordLookupSeq.current = seq;
    const timer = setTimeout(() => {
      setDiscordChannelsLoading(true);
      setDiscordChannelsError(null);
      void listDiscordChannelsByToken(token)
        .then((channels) => {
          if (discordLookupSeq.current !== seq) return;
          setDiscordChannelOptions(channels);
        })
        .catch((error) => {
          if (discordLookupSeq.current !== seq) return;
          setDiscordChannelOptions([]);
          setDiscordChannelsError(resolveError(error));
        })
        .finally(() => {
          if (discordLookupSeq.current !== seq) return;
          setDiscordChannelsLoading(false);
        });
    }, 450);

    return () => {
      clearTimeout(timer);
    };
  }, [editorOpen, editorChannel, editorToken, resolveError]);

  return { discordChannelsLoading, discordChannelOptions, discordChannelsError };
}
