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
        msg:
          successMsg ??
          t({
            ko: "채널 설정 저장 완료",
            en: "Channel settings saved",
            ja: "チャネル設定を保存しました",
            zh: "Channel settings saved",
            de: "Kanaleinstellungen gespeichert",
          }),
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
    persistChannelsForm(
      next,
      t({
        ko: "채팅 삭제 완료",
        en: "Chat deleted",
        ja: "チャットを削除しました",
        zh: "Chat deleted",
        de: "Chat gelöscht",
      }),
    );
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
      setEditorError(
        t({
          ko: "토큰을 입력해주세요.",
          en: "Please enter a token.",
          ja: "トークンを入力してください。",
          zh: "Please enter a token.",
          de: "Bitte geben Sie einen Token ein.",
        }),
      );
      return null;
    }
    if (!name) {
      setEditorError(
        t({
          ko: "채팅 이름을 입력해주세요.",
          en: "Please enter a chat name.",
          ja: "チャット名を入力してください。",
          zh: "Please enter a chat name.",
          de: "Bitte geben Sie einen Chat-Namen ein.",
        }),
      );
      return null;
    }
    if (!targetId) {
      setEditorError(
        t({
          ko: "채널/대상 ID를 입력해주세요.",
          en: "Please enter a channel/target ID.",
          ja: "チャンネル/対象 ID を入力してください。",
          zh: "Please enter a channel/target ID.",
          de: "Bitte geben Sie eine Kanal-/Ziel-ID ein.",
        }),
      );
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

    const savedOk = persistChannelsForm(
      next,
      t({
        ko: "채팅 설정 저장 완료",
        en: "Chat saved",
        ja: "チャット設定を保存しました",
        zh: "Chat saved",
        de: "Chat gespeichert",
      }),
    );
    if (!savedOk) {
      setEditorError(
        t({
          ko: "채팅 저장에 실패했습니다. 다시 시도해주세요.",
          en: "Failed to save chat. Please try again.",
          ja: "チャット保存に失敗しました。再試行してください。",
          zh: "Failed to save chat. Please try again.",
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
