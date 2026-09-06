import { useState } from "react";
import type { MessengerChannelsConfig, MessengerSessionConfig } from "../../../types";
import type { ChannelSettingsTabProps } from "../types";
import { isWorkflowPackKey } from "./constants";
import {
  type ChatRow,
  createEditorState,
  createSessionId,
  normalizeChannelsConfig,
  resolveChannelsConfig,
} from "./state";

type UseChatEditorInput = {
  t: ChannelSettingsTabProps["t"];
  form: ChannelSettingsTabProps["form"];
  setForm: ChannelSettingsTabProps["setForm"];
  persistSettings: ChannelSettingsTabProps["persistSettings"];
  channelsConfig: MessengerChannelsConfig;
  onSaved: (result: { ok: boolean; msg: string } | null) => void;
};

export function useChatEditor({ t, form, setForm, persistSettings, channelsConfig, onSaved }: UseChatEditorInput) {
  const [_saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<{ ok: boolean; msg: string } | null>(null);
  const [editor, setEditor] = useState(() => createEditorState(channelsConfig));
  const [editorError, setEditorError] = useState<string | null>(null);

  const persistChannelsForm = (nextChannels: ReturnType<typeof resolveChannelsConfig>, successMsg?: string) => {
    const normalized = normalizeChannelsConfig(nextChannels);
    const nextForm = { ...form, messengerChannels: normalized };
    setForm(nextForm);
    setSaving(true);
    setSaved(null);
    try {
      persistSettings(nextForm);
      const result = {
        ok: true,
        msg: successMsg ?? t({ en: "Channel settings saved", de: "Kanaleinstellungen gespeichert" }),
      };
      setSaved(result);
      onSaved(result);
      setTimeout(() => setSaved(null), 2500);
      return true;
    } catch (error) {
      const result = { ok: false, msg: error instanceof Error ? error.message : String(error) };
      setSaved(result);
      onSaved(result);
      return false;
    } finally {
      setSaving(false);
    }
  };

  const removeChat = (row: ChatRow) => {
    const next = resolveChannelsConfig(form.messengerChannels);
    next[row.channel] = {
      ...next[row.channel],
      sessions: next[row.channel].sessions.filter((session) => session.id !== row.session.id),
    };
    persistChannelsForm(next, t({ en: "Chat deleted", de: "Chat gelöscht" }));
  };

  const openCreateModal = () => {
    setEditor({
      ...createEditorState(channelsConfig),
      open: true,
      mode: "create",
    });
    setEditorError(null);
  };

  const openEditModal = (row: ChatRow) => {
    setEditor({
      open: true,
      mode: "edit",
      ref: { channel: row.channel, sessionId: row.session.id },
      channel: row.channel,
      token: row.session.token?.trim() || (channelsConfig[row.channel].token ?? ""),
      name: row.session.name ?? "",
      targetId: row.session.targetId ?? "",
      enabled: row.session.enabled !== false,
      agentId: row.session.agentId ?? "",
      workflowPackKey: isWorkflowPackKey(row.session.workflowPackKey) ? row.session.workflowPackKey : "development",
      receiveEnabled: channelsConfig[row.channel].receiveEnabled !== false,
    });
    setEditorError(null);
  };

  const closeEditorModal = () => {
    setEditor((prev) => ({ ...prev, open: false, ref: null }));
    setEditorError(null);
  };

  const handleSaveEditor = (): string | null => {
    const token = editor.token.trim();
    const name = editor.name.trim();
    const targetId = editor.targetId.trim();
    const agentId = editor.agentId.trim();

    if (!token) {
      setEditorError(t({ en: "Please enter a token.", de: "Bitte geben Sie einen Token ein." }));
      return null;
    }
    if (!name) {
      setEditorError(t({ en: "Please enter a chat name.", de: "Bitte geben Sie einen Chat-Namen ein." }));
      return null;
    }
    if (!targetId) {
      setEditorError(t({ en: "Please enter a channel/target ID.", de: "Bitte geben Sie eine Kanal-/Ziel-ID ein." }));
      return null;
    }

    const next = resolveChannelsConfig(form.messengerChannels);

    next[editor.channel] = {
      ...next[editor.channel],
      receiveEnabled: editor.channel === "telegram" ? editor.receiveEnabled : next[editor.channel].receiveEnabled,
    };

    const nextSession: MessengerSessionConfig = {
      id: editor.ref?.sessionId || createSessionId(editor.channel),
      name,
      targetId,
      enabled: editor.enabled,
      token,
      agentId: agentId || undefined,
      workflowPackKey: editor.workflowPackKey,
    };

    let insertIndex: number | null = null;
    if (editor.ref) {
      const sourceChannel = editor.ref.channel;
      const sourceSessions = [...next[sourceChannel].sessions];
      const sourceIndex = sourceSessions.findIndex((session) => session.id === editor.ref?.sessionId);
      if (sourceIndex >= 0) {
        sourceSessions.splice(sourceIndex, 1);
        next[sourceChannel] = { ...next[sourceChannel], sessions: sourceSessions };
        if (sourceChannel === editor.channel) {
          insertIndex = sourceIndex;
        }
      }
    }

    const targetSessions = [...next[editor.channel].sessions];
    if (insertIndex !== null && insertIndex >= 0 && insertIndex <= targetSessions.length) {
      targetSessions.splice(insertIndex, 0, nextSession);
    } else {
      targetSessions.push(nextSession);
    }

    next[editor.channel] = {
      ...next[editor.channel],
      sessions: targetSessions,
    };

    const savedOk = persistChannelsForm(next, t({ en: "Chat saved", de: "Chat gespeichert" }));
    if (!savedOk) {
      setEditorError(
        t({
          en: "Failed to save chat. Please try again.",
          de: "Chat konnte nicht gespeichert werden. Bitte versuchen Sie es erneut.",
        }),
      );
      return null;
    }
    closeEditorModal();
    return `${editor.channel}:${nextSession.id}`;
  };

  return {
    saved,
    editor,
    setEditor,
    editorError,
    openCreateModal,
    openEditModal,
    closeEditorModal,
    handleSaveEditor,
    persistChannelsForm,
    removeChat,
  };
}
