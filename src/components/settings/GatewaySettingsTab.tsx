import { useEffect, useMemo, useState } from "react";
import { sendMessengerRuntimeMessage } from "../../api";
import { MESSENGER_CHANNELS } from "../../types";
import type { ChannelSettingsTabProps } from "./types";
import ChatEditorModal from "./gateway-settings/ChatEditorModal";
import { CHANNEL_META } from "./gateway-settings/constants";
import { type ChatRow, resolveChannelsConfig } from "./gateway-settings/state";
import { useGatewayData } from "./gateway-settings/useGatewayData";
import { useDiscordChannelLookup } from "./gateway-settings/useDiscordChannelLookup";
import { useChatEditor } from "./gateway-settings/useChatEditor";
import ChatSessionList from "./gateway-settings/ChatSessionList";
import RuntimeSessionsPanel from "./gateway-settings/RuntimeSessionsPanel";
import ReceiverStatusPanel from "./gateway-settings/ReceiverStatusPanel";

export default function GatewaySettingsTab({ t, form, setForm, persistSettings }: ChannelSettingsTabProps) {
  const channelsConfig = resolveChannelsConfig(form.messengerChannels);

  const [sending, setSending] = useState(false);
  const [sendText, setSendText] = useState("");
  const [sendStatus, setSendStatus] = useState<{ ok: boolean; msg: string } | null>(null);

  const data = useGatewayData(t);
  const chatEditor = useChatEditor({
    t,
    form,
    setForm,
    persistSettings,
    channelsConfig,
    onSaved: () => {},
  });

  const discord = useDiscordChannelLookup({
    editorOpen: chatEditor.editor.open,
    editorChannel: chatEditor.editor.channel,
    editorToken: chatEditor.editor.token,
    t,
  });

  const chatRows = useMemo<ChatRow[]>(() => {
    return MESSENGER_CHANNELS.flatMap((channel) => {
      const channelConfig = channelsConfig[channel];
      return (channelConfig.sessions ?? [])
        .map((session) => ({
          key: `${channel}:${session.id}`,
          channel,
          token: (session.token ?? "").trim() || (channelConfig.token ?? ""),
          receiveEnabled: channelConfig.receiveEnabled !== false,
          session,
        }))
        .filter((entry) => entry.session.targetId.trim().length > 0);
    });
  }, [channelsConfig]);

  const [selectedChatKey, setSelectedChatKey] = useState<string>("");

  useEffect(() => {
    if (chatRows.length === 0) {
      setSelectedChatKey("");
      return;
    }
    const exists = chatRows.some((row) => row.key === selectedChatKey);
    if (!exists) {
      setSelectedChatKey(chatRows[0].key);
    }
  }, [chatRows, selectedChatKey]);

  const selectedChat = chatRows.find((row) => row.key === selectedChatKey) ?? null;

  const handleSendMessage = async () => {
    if (!selectedChat || !sendText.trim()) {
      return;
    }

    setSending(true);
    setSendStatus(null);
    try {
      const result = await sendMessengerRuntimeMessage({
        sessionKey: selectedChat.key,
        text: sendText.trim(),
      });
      if (!result.ok) {
        setSendStatus({ ok: false, msg: result.error || "send_failed" });
        return;
      }
      setSendStatus({
        ok: true,
        msg: t({
          ko: "메시지 전송 완료",
          en: "Message sent",
          ja: "メッセージを送信しました",
          zh: "Message sent",
          de: "Nachricht gesendet",
        }),
      });
      setSendText("");
    } catch (error) {
      setSendStatus({ ok: false, msg: error instanceof Error ? error.message : String(error) });
    } finally {
      setSending(false);
    }
  };

  const handleSaveEditorAndSelect = () => {
    const newKey = chatEditor.handleSaveEditor();
    if (newKey) {
      setSelectedChatKey(newKey);
    }
  };

  const handleRemoveChat = (row: ChatRow) => {
    chatEditor.removeChat(row);
    setSendStatus(null);
  };

  const selectedChatTransportReady = selectedChat ? CHANNEL_META[selectedChat.channel].transportReady : false;

  return (
    <section
      className="space-y-4 rounded-xl border p-4 sm:p-5"
      style={{ borderColor: "var(--th-border)", background: "var(--th-card-bg)" }}
    >
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold uppercase tracking-wider" style={{ color: "var(--th-text-secondary)" }}>
          {t({
            ko: "채널 메시지 설정",
            en: "Channel Messaging",
            ja: "チャネルメッセージ設定",
            zh: "Channel Messaging",
            de: "Kanal-Messaging",
          })}
        </h3>
        {chatEditor.saved && (
          <span className={`text-xs ${chatEditor.saved.ok ? "text-emerald-400" : "text-red-400"}`}>
            {chatEditor.saved.msg}
          </span>
        )}
      </div>

      <p className="text-xs" style={{ color: "var(--th-text-secondary)" }}>
        {t({
          ko: "이 탭에서 메신저 채널을 직접 설정할 수 있습니다. '새 채팅 추가'로 메신저/토큰/대상 ID/대화 Agent를 등록하세요.",
          en: "You can configure messenger channels directly in this tab. Use 'Add Chat' to register messenger/token/target ID/conversation agent.",
          ja: "このタブでメッセンジャーチャネルを直接設定できます。'チャット追加'からメッセンジャー/トークン/対象ID/担当Agentを登録してください。",
          zh: "You can configure messenger channels directly in this tab. Use 'Add Chat' to register messenger/token/target ID/conversation agent.",
          de: "In diesem Tab können Sie Messenger-Kanäle direkt konfigurieren. Verwenden Sie 'Chat hinzufügen', um Messenger/Token/Ziel-ID/Agent zu registrieren.",
        })}
      </p>

      <ChatSessionList
        t={t}
        chatRows={chatRows}
        agentById={data.agentById}
        spriteMap={data.spriteMap}
        workflowPackNameByKey={data.workflowPackNameByKey}
        onAdd={chatEditor.openCreateModal}
        onEdit={chatEditor.openEditModal}
        onDelete={handleRemoveChat}
      />

      <div
        className="rounded-lg border p-3 space-y-3"
        style={{ borderColor: "var(--th-border)", background: "var(--th-input-bg)" }}
      >
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold" style={{ color: "var(--th-text-heading)" }}>
            {t({
              ko: "세션 테스트 전송",
              en: "Test Send",
              ja: "送信テスト",
              zh: "Test Send",
              de: "Testnachricht senden",
            })}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => void data.loadMessengerReceiverStatus()}
              disabled={data.receiverLoading}
              className="text-xs text-blue-400 hover:text-blue-300 transition-colors disabled:opacity-60"
            >
              {t({ ko: "수신상태", en: "Receiver", ja: "受信状態", zh: "Receiver", de: "Empfänger" })}
            </button>
            <button
              onClick={() => void data.loadRuntimeSessions()}
              disabled={data.runtimeLoading}
              className="text-xs text-blue-400 hover:text-blue-300 transition-colors disabled:opacity-60"
            >
              {t({ ko: "실행중 세션", en: "Runtime", ja: "実行セッション", zh: "Runtime", de: "Laufzeit" })}
            </button>
          </div>
        </div>

        <ReceiverStatusPanel
          t={t}
          telegramReceiverStatus={data.telegramReceiverStatus}
          discordReceiverStatus={data.discordReceiverStatus}
        />

        <div>
          <label className="block text-xs mb-1" style={{ color: "var(--th-text-secondary)" }}>
            {t({
              ko: "전송 대상 세션",
              en: "Target Session",
              ja: "送信先セッション",
              zh: "Target Session",
              de: "Zielsitzung",
            })}
          </label>
          {chatRows.length === 0 ? (
            <div className="text-xs py-1" style={{ color: "var(--th-text-muted)" }}>
              {t({
                ko: "저장된 세션이 없습니다. 먼저 채팅을 등록하세요.",
                en: "No saved session. Add a chat first.",
                ja: "保存済みセッションがありません。先にチャットを追加してください。",
                zh: "No saved session. Add a chat first.",
                de: "Keine gespeicherte Sitzung. Bitte zuerst einen Chat hinzufügen.",
              })}
            </div>
          ) : (
            <select
              value={selectedChat?.key ?? ""}
              onChange={(e) => setSelectedChatKey(e.target.value)}
              className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:border-blue-500"
              style={{
                background: "var(--th-input-bg)",
                borderColor: "var(--th-input-border)",
                color: "var(--th-text-primary)",
              }}
            >
              {chatRows.map((row) => (
                <option key={row.key} value={row.key}>
                  {CHANNEL_META[row.channel].label} · {row.session.name} ({row.session.targetId})
                </option>
              ))}
            </select>
          )}
        </div>

        <textarea
          value={sendText}
          onChange={(e) => setSendText(e.target.value)}
          rows={3}
          placeholder={t({
            ko: "테스트 메시지를 입력하세요...",
            en: "Type a test message...",
            ja: "テストメッセージを入力...",
            zh: "Type a test message...",
            de: "Testnachricht eingeben...",
          })}
          className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:border-blue-500 resize-y"
          style={{
            background: "var(--th-input-bg)",
            borderColor: "var(--th-input-border)",
            color: "var(--th-text-primary)",
          }}
        />

        {!selectedChatTransportReady && selectedChat && (
          <div className="text-xs px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-300">
            {t({
              ko: "이 채널은 현재 설정 저장/매핑은 가능하지만, 직접 전송 런타임은 아직 준비되지 않았습니다.",
              en: "This channel can be configured and mapped, but direct transport runtime is not ready yet.",
              ja: "このチャネルは設定/マッピングは可能ですが、直接送信ランタイムは未対応です。",
              zh: "This channel can be configured and mapped, but direct transport runtime is not ready yet.",
              de: "Dieser Kanal kann konfiguriert und gemappt werden, aber der direkte Transport-Laufzeitbetrieb ist noch nicht bereit.",
            })}
          </div>
        )}

        <button
          onClick={() => void handleSendMessage()}
          disabled={sending || !selectedChat || !sendText.trim() || !selectedChatTransportReady}
          className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {sending
            ? t({ ko: "전송 중...", en: "Sending...", ja: "送信中...", zh: "Sending...", de: "Wird gesendet..." })
            : t({ ko: "메시지 전송", en: "Send", ja: "送信", zh: "Send", de: "Senden" })}
        </button>

        {sendStatus && (
          <div
            className={`text-xs px-3 py-2 rounded-lg ${
              sendStatus.ok
                ? "bg-green-500/10 text-green-400 border border-green-500/20"
                : "bg-red-500/10 text-red-400 border border-red-500/20"
            }`}
          >
            {sendStatus.msg}
          </div>
        )}

        <RuntimeSessionsPanel t={t} runtimeSessions={data.runtimeSessions} />
      </div>

      {chatEditor.editor.open && (
        <ChatEditorModal
          t={t}
          editor={chatEditor.editor}
          setEditor={chatEditor.setEditor}
          closeEditorModal={chatEditor.closeEditorModal}
          handleSaveEditor={handleSaveEditorAndSelect}
          channelsConfig={channelsConfig}
          agents={data.agents}
          agentsLoading={data.agentsLoading}
          workflowPackOptions={data.workflowPackOptions}
          workflowPacksLoading={data.workflowPacksLoading}
          editorError={chatEditor.editorError}
          discordChannels={discord.discordChannelOptions}
          discordChannelsLoading={discord.discordChannelsLoading}
          discordChannelsError={discord.discordChannelsError}
        />
      )}
    </section>
  );
}
