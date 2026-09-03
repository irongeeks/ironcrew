import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import type { Agent, Message, Project } from "../../types";
import AgentAvatar, { buildSpriteMap } from "../AgentAvatar";
import { useI18n } from "../../i18n";
import { createProject, getProjects, isApiRequestError } from "../../api";
import { parseDecisionRequest } from "../chat/decision-request";
import type { DecisionOption } from "../chat/decision-request";
import ChatComposer from "../chat-panel/ChatComposer";
import ChatMessageList from "../chat-panel/ChatMessageList";
import { useDecisionReplyHandlers } from "../chat-panel/useDecisionReply";
import {
  ROLE_LABELS,
  STATUS_COLORS,
  STATUS_LABELS,
  type ChatMode,
  type PendingSendAction,
  type ProjectMetaPayload,
  type StreamingMessage,
} from "../chat-panel/model";
import ProjectFlowDialog from "../chat-panel/ProjectFlowDialog";
import { MobileBottomSheet } from "./MobileBottomSheet";

interface MobileChatPanelProps {
  selectedAgent: Agent | null;
  messages: Message[];
  agents: Agent[];
  streamingMessage?: StreamingMessage | null;
  onSendMessage: (
    content: string,
    receiverType: "agent" | "department" | "all",
    receiverId?: string,
    messageType?: string,
    projectMeta?: {
      project_id?: string;
      project_path?: string;
      project_context?: string;
    },
  ) => void | Promise<void>;
  onSendAnnouncement: (content: string) => void;
  onSendDirective: (
    content: string,
    projectMeta?: {
      project_id?: string;
      project_path?: string;
      project_context?: string;
    },
  ) => void;
  onClearMessages?: (agentId?: string) => void;
  onSelectAgent?: (agent: Agent | null) => void;
  onClose: () => void;
}

export function MobileChatPanel({
  selectedAgent,
  messages,
  agents,
  streamingMessage,
  onSendMessage,
  onSendAnnouncement,
  onSendDirective,
  onClearMessages,
  onSelectAgent,
  onClose,
}: MobileChatPanelProps) {
  const [agentPickerOpen, setAgentPickerOpen] = useState(false);
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<ChatMode>(selectedAgent ? "task" : "announcement");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const spriteMap = useMemo(() => buildSpriteMap(agents), [agents]);
  const { t, locale } = useI18n();
  const isKorean = locale.startsWith("ko");

  const groupedAgents = useMemo(() => {
    const groups = new Map<string, { label: string; items: Agent[] }>();
    for (const a of agents) {
      const key = a.department?.id ?? a.department_id ?? "__unassigned__";
      const label = a.department
        ? (isKorean ? a.department.name_ko || a.department.name : a.department.name || a.department.name_ko) || key
        : key === "__unassigned__"
          ? "—"
          : key;
      const bucket = groups.get(key);
      if (bucket) bucket.items.push(a);
      else groups.set(key, { label, items: [a] });
    }
    return Array.from(groups.values()).sort((a, b) => a.label.localeCompare(b.label));
  }, [agents, isKorean]);

  const tr = (ko: string, en: string, ja = en, zh = en, de = en) => t({ ko, en, ja, zh, de });

  const getAgentName = (agent: Agent | null | undefined) => {
    if (!agent) return "";
    return isKorean ? agent.name_ko || agent.name : agent.name || agent.name_ko;
  };

  const getRoleLabel = (role: string) => {
    const label = ROLE_LABELS[role];
    return label ? t(label) : role;
  };

  const getStatusLabel = (status: string) => {
    const label = STATUS_LABELS[status];
    return label ? t(label) : status;
  };

  const selectedDeptName = selectedAgent?.department
    ? isKorean
      ? selectedAgent.department.name_ko || selectedAgent.department.name
      : selectedAgent.department.name || selectedAgent.department.name_ko
    : selectedAgent?.department_id;

  const selectedTaskId = selectedAgent?.current_task_id;

  // Auto-scroll to bottom on new messages or streaming delta
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingMessage?.content]);

  // Switch mode when agent selection changes
  useEffect(() => {
    if (!selectedAgent) {
      setMode("announcement");
    } else if (mode === "announcement") {
      setMode("task");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAgent]);

  const isDirectiveMode = input.trimStart().startsWith("$");
  const [pendingSend, setPendingSend] = useState<PendingSendAction | null>(null);
  const [projectFlowOpen, setProjectFlowOpen] = useState(false);
  const [projectFlowStep, setProjectFlowStep] = useState<"choose" | "existing" | "new" | "confirm">("choose");
  const [projectItems, setProjectItems] = useState<Project[]>([]);
  const [projectLoading, setProjectLoading] = useState(false);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [existingProjectInput, setExistingProjectInput] = useState("");
  const [existingProjectError, setExistingProjectError] = useState("");
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectPath, setNewProjectPath] = useState("");
  const [newProjectGoal, setNewProjectGoal] = useState("");
  const [newProjectError, setNewProjectError] = useState("");
  const [projectSaving, setProjectSaving] = useState(false);
  const [decisionReplyKey, setDecisionReplyKey] = useState<string | null>(null);
  const isDirectivePending = pendingSend?.kind === "directive";

  const closeProjectFlow = () => {
    setProjectFlowOpen(false);
    setProjectFlowStep("choose");
    setPendingSend(null);
    setSelectedProject(null);
    setExistingProjectInput("");
    setExistingProjectError("");
    setNewProjectName("");
    setNewProjectPath("");
    setNewProjectGoal("");
    setNewProjectError("");
    setProjectItems([]);
  };

  const loadRecentProjects = useCallback(async () => {
    setProjectLoading(true);
    try {
      const res = await getProjects({ page: 1, page_size: 10 });
      setProjectItems(res.projects.slice(0, 10));
    } catch (err) {
      console.error("Failed to load projects:", err);
    } finally {
      setProjectLoading(false);
    }
  }, []);

  const resolveExistingProjectSelection = useCallback(
    (raw: string): Project | null => {
      const trimmed = raw.trim();
      if (!trimmed || projectItems.length === 0) return null;

      if (/^\d+$/.test(trimmed)) {
        const idx = Number.parseInt(trimmed, 10);
        if (idx >= 1 && idx <= projectItems.length) {
          return projectItems[idx - 1];
        }
      }

      const query = trimmed.toLowerCase();
      const tokens = query.split(/\s+/).filter(Boolean);
      let best: { project: Project; score: number } | null = null;

      for (const p of projectItems) {
        const name = p.name.toLowerCase();
        const path = p.project_path.toLowerCase();
        const goal = p.core_goal.toLowerCase();
        let score = 0;

        if (name === query) score = Math.max(score, 100);
        if (name.startsWith(query)) score = Math.max(score, 90);
        if (name.includes(query)) score = Math.max(score, 80);
        if (path === query) score = Math.max(score, 75);
        if (path.includes(query)) score = Math.max(score, 65);
        if (goal.includes(query)) score = Math.max(score, 50);

        if (tokens.length > 0) {
          const tokenHits = tokens.filter((tk) => name.includes(tk) || path.includes(tk) || goal.includes(tk)).length;
          score = Math.max(score, tokenHits * 20);
        }

        if (!best || score > best.score) {
          best = { project: p, score };
        }
      }

      if (!best || best.score < 50) return null;
      return best.project;
    },
    [projectItems],
  );

  const applyExistingProjectSelection = useCallback(() => {
    const picked = resolveExistingProjectSelection(existingProjectInput);
    if (!picked) {
      setExistingProjectError(
        tr(
          "번호(1-10) 또는 프로젝트명을 다시 입력해주세요.",
          "Please enter a number (1-10) or a project name.",
          "番号(1-10)またはプロジェクト名を入力してください。",
          "请输入编号(1-10)或项目名称。",
          "Bitte eine Nummer (1-10) oder einen Projektnamen eingeben.",
        ),
      );
      return;
    }
    setExistingProjectError("");
    setSelectedProject(picked);
    setProjectFlowStep("confirm");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existingProjectInput, resolveExistingProjectSelection]);

  const handleChooseExistingProject = useCallback(() => {
    setProjectFlowStep("existing");
    setExistingProjectInput("");
    setExistingProjectError("");
    void loadRecentProjects();
  }, [loadRecentProjects]);

  const handleSelectExistingProject = useCallback((project: Project, index: number) => {
    setSelectedProject(project);
    setExistingProjectInput(String(index + 1));
    setExistingProjectError("");
    setProjectFlowStep("confirm");
  }, []);

  const handleExistingProjectInputChange = useCallback(
    (value: string) => {
      setExistingProjectInput(value);
      if (existingProjectError) setExistingProjectError("");
    },
    [existingProjectError],
  );

  const dispatchPending = useCallback(
    (action: PendingSendAction, projectMeta?: ProjectMetaPayload) => {
      if (action.kind === "directive") {
        onSendDirective(action.content, projectMeta);
        return;
      }
      if (action.kind === "announcement") {
        onSendAnnouncement(action.content);
        return;
      }
      if (action.kind === "task") {
        onSendMessage(action.content, "agent", action.receiverId, "task_assign", projectMeta);
        return;
      }
      if (action.kind === "report") {
        onSendMessage(action.content, "agent", action.receiverId, "report", projectMeta);
        return;
      }
      if (action.kind === "chat") {
        onSendMessage(action.content, "agent", action.receiverId, "chat", projectMeta);
        return;
      }
      onSendMessage(action.content, "all", undefined, undefined, projectMeta);
    },
    [onSendAnnouncement, onSendDirective, onSendMessage],
  );

  const handleConfirmProject = () => {
    if (!pendingSend || !selectedProject) return;
    const projectMeta: ProjectMetaPayload = {
      project_id: selectedProject.id,
      project_path: selectedProject.project_path,
      project_context: selectedProject.core_goal,
    };
    dispatchPending(pendingSend, projectMeta);
    setInput("");
    textareaRef.current?.focus();
    closeProjectFlow();
  };

  const handleCreateProject = async () => {
    const goal = isDirectivePending ? (pendingSend?.content ?? "").trim() : newProjectGoal.trim();
    if (!newProjectName.trim() || !newProjectPath.trim() || !goal || projectSaving) return;
    setProjectSaving(true);
    setNewProjectError("");
    try {
      const created = await createProject({
        name: newProjectName.trim(),
        project_path: newProjectPath.trim(),
        core_goal: goal,
      });
      setSelectedProject(created);
      setProjectFlowStep("confirm");
    } catch (err) {
      console.error("Failed to create project:", err);
      if (isApiRequestError(err) && err.code === "project_path_conflict") {
        const details =
          (err.details as { existing_project_name?: unknown; existing_project_path?: unknown } | null) ?? null;
        const existingName = typeof details?.existing_project_name === "string" ? details.existing_project_name : "";
        setNewProjectError(
          tr(
            existingName
              ? `이 경로는 이미 '${existingName}' 프로젝트에서 사용 중입니다. 기존 프로젝트를 선택해주세요.`
              : "이미 등록된 프로젝트 경로입니다. 기존 프로젝트를 선택해주세요.",
            existingName
              ? `This path is already used by '${existingName}'. Please select the existing project.`
              : "This path is already registered by another project. Please select the existing project.",
          ),
        );
      } else {
        setNewProjectError(tr("프로젝트 등록에 실패했습니다.", "Failed to create project."));
      }
    } finally {
      setProjectSaving(false);
    }
  };

  const openProjectBranch = (action: PendingSendAction) => {
    setPendingSend(action);
    setProjectFlowOpen(true);
    setProjectFlowStep("choose");
    setSelectedProject(null);
    setExistingProjectInput("");
    setExistingProjectError("");
    setProjectItems([]);
    setNewProjectGoal(action.kind === "directive" ? action.content : "");
  };

  const handleSend = () => {
    const trimmed = input.trim();
    if (!trimmed) return;

    let action: PendingSendAction;
    if (trimmed.startsWith("$")) {
      const directiveContent = trimmed.slice(1).trim();
      if (!directiveContent) return;
      action = { kind: "directive", content: directiveContent };
    } else if (mode === "announcement") {
      action = { kind: "announcement", content: trimmed };
    } else if (mode === "task" && selectedAgent) {
      action = { kind: "task", content: trimmed, receiverId: selectedAgent.id };
    } else if (mode === "report" && selectedAgent) {
      action = {
        kind: "report",
        content: `[${tr("보고 요청", "Report Request")}] ${trimmed}`,
        receiverId: selectedAgent.id,
      };
    } else if (selectedAgent) {
      action = { kind: "chat", content: trimmed, receiverId: selectedAgent.id };
    } else {
      action = { kind: "broadcast", content: trimmed };
    }

    const requiresProject = action.kind === "directive" || action.kind === "task" || action.kind === "report";

    if (requiresProject) {
      openProjectBranch(action);
      return;
    }

    dispatchPending(action);
    setInput("");
    textareaRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSend();
    }
  };

  useEffect(() => {
    if (!projectFlowOpen) return;
    if (projectFlowStep !== "existing") return;
    void loadRecentProjects();
  }, [projectFlowOpen, projectFlowStep, loadRecentProjects]);

  const canCreateProject =
    Boolean(newProjectName.trim()) &&
    Boolean(newProjectPath.trim()) &&
    Boolean(isDirectivePending ? (pendingSend?.content ?? "").trim() : newProjectGoal.trim());

  const isAnnouncementMode = mode === "announcement";

  // Filter messages relevant to current view
  const selectedAgentId = selectedAgent?.id;
  const visibleMessages = useMemo(
    () =>
      messages.filter((msg) => {
        if (!selectedAgentId) {
          return msg.receiver_type === "all" || msg.message_type === "announcement" || msg.message_type === "directive";
        }
        if (selectedTaskId && msg.task_id === selectedTaskId) return true;
        return (
          (msg.sender_type === "ceo" && msg.receiver_type === "agent" && msg.receiver_id === selectedAgentId) ||
          (msg.sender_type === "agent" && msg.sender_id === selectedAgentId) ||
          msg.message_type === "announcement" ||
          msg.message_type === "directive" ||
          msg.receiver_type === "all"
        );
      }),
    [messages, selectedAgentId, selectedTaskId],
  );

  const decisionRequestByMessage = useMemo(() => {
    const mapped = new Map<string, { options: DecisionOption[] }>();
    if (!selectedAgentId) return mapped;
    for (const msg of visibleMessages) {
      if (msg.sender_type !== "agent" || msg.sender_id !== selectedAgentId) continue;
      const parsed = parseDecisionRequest(msg.content);
      if (parsed) mapped.set(msg.id, parsed);
    }
    return mapped;
  }, [selectedAgentId, visibleMessages]);

  const { handleDecisionOptionReply, handleDecisionManualDraft } = useDecisionReplyHandlers({
    tr,
    onSendMessage,
    setDecisionReplyKey,
    setMode,
    setInput,
    textareaRef,
  });

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col"
      style={{
        background: "var(--bg-surface-solid, var(--th-bg-secondary))",
        fontFamily: "'JetBrains Mono', monospace",
      }}
    >
      {/* Mobile header — back + agent/announcement context + clear action */}
      <div
        className="chat-header flex flex-shrink-0 items-center gap-3 px-3 py-3"
        style={{
          background: "var(--bg-surface-solid, var(--th-card-bg))",
        }}
      >
        <button
          type="button"
          aria-label="Back"
          className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-lg"
          style={{ color: "var(--text-primary, var(--th-text))" }}
          onClick={onClose}
        >
          &larr;
        </button>

        {selectedAgent ? (
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <div className="relative flex-shrink-0">
              <AgentAvatar agent={selectedAgent} spriteMap={spriteMap} size={40} />
              <span
                className={`absolute bottom-0 right-0 h-3 w-3 rounded-full border-2 ${
                  STATUS_COLORS[selectedAgent.status] ?? "bg-[var(--text-muted)]"
                }`}
                style={{ borderColor: "var(--bg-surface-solid, var(--th-card-bg))" }}
              />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span
                  className="truncate text-sm font-semibold"
                  style={{ color: "var(--th-text-heading, var(--th-text-primary))" }}
                >
                  {getAgentName(selectedAgent)}
                </span>
                <span
                  className="flex-shrink-0 rounded px-1.5 py-0.5 text-xs"
                  style={{ background: "var(--th-bg-surface-hover)", color: "var(--th-text-secondary)" }}
                >
                  {getRoleLabel(selectedAgent.role)}
                </span>
              </div>
              <div className="mt-0.5 flex items-center gap-1.5 text-xs" style={{ color: "var(--th-text-secondary)" }}>
                <span className="truncate">{selectedDeptName}</span>
                <span style={{ color: "var(--th-text-muted)" }}>·</span>
                <span>{getStatusLabel(selectedAgent.status)}</span>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-yellow-500/20 text-xl">
              📢
            </div>
            <div className="min-w-0 flex-1">
              <div
                className="truncate text-sm font-semibold"
                style={{ color: "var(--th-text-heading, var(--th-text-primary))" }}
              >
                {tr("전사 공지", "Company Announcement", "全体告知", "全员公告", "Unternehmensankündigung")}
              </div>
              <div className="mt-0.5 truncate text-xs" style={{ color: "var(--th-text-secondary)" }}>
                {tr(
                  "모든 에이전트에게 전달됩니다",
                  "Sent to all agents",
                  "すべてのエージェントに送信されます",
                  "将发送给所有代理",
                  "Wird an alle Agenten gesendet",
                )}
              </div>
            </div>
          </div>
        )}

        {onSelectAgent ? (
          <button
            type="button"
            onClick={() => setAgentPickerOpen(true)}
            aria-label={tr("에이전트 선택", "Select agent", "エージェント選択", "选择代理", "Agent auswählen")}
            className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg"
            style={{ color: "var(--th-text-secondary)" }}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-4 w-4"
              aria-hidden="true"
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
        ) : null}

        {onClearMessages && visibleMessages.length > 0 ? (
          <button
            type="button"
            onClick={() => {
              const ok = window.confirm(
                selectedAgent
                  ? tr(
                      `${getAgentName(selectedAgent)}와의 대화를 삭제하시겠습니까?`,
                      `Delete conversation with ${getAgentName(selectedAgent)}?`,
                      `${getAgentName(selectedAgent)}との会話を削除しますか？`,
                      `要删除与 ${getAgentName(selectedAgent)} 的对话吗？`,
                      `Gespräch mit ${getAgentName(selectedAgent)} löschen?`,
                    )
                  : tr(
                      "전사 공지 내역을 삭제하시겠습니까?",
                      "Delete announcement history?",
                      "全体告知履歴を削除しますか？",
                      "要删除全员公告记录吗？",
                      "Ankündigungsverlauf löschen?",
                    ),
              );
              if (ok) onClearMessages(selectedAgent?.id);
            }}
            aria-label={tr("대화 내역 삭제", "Clear history", "履歴を削除", "清除记录", "Verlauf löschen")}
            className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg"
            style={{ color: "var(--th-text-muted)" }}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-4 w-4"
            >
              <path d="M3 6h18" />
              <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
            </svg>
          </button>
        ) : (
          <div className="min-w-[44px]" />
        )}
      </div>

      {isAnnouncementMode && (
        <div className="flex flex-shrink-0 items-center gap-2 border-b border-yellow-500/30 bg-yellow-500/10 px-4 py-2">
          <span className="text-sm font-medium text-yellow-400">
            📢{" "}
            {tr(
              "전사 공지 모드 - 모든 에이전트에게 전달됩니다",
              "Announcement mode - sent to all agents",
              "全体告知モード - すべてのエージェントに送信",
              "全员公告模式 - 将发送给所有代理",
              "Ankündigungsmodus – wird an alle Agenten gesendet",
            )}
          </span>
        </div>
      )}

      {/* Message list */}
      <ChatMessageList
        selectedAgent={selectedAgent}
        visibleMessages={visibleMessages}
        agents={agents}
        spriteMap={spriteMap}
        locale={locale}
        tr={tr}
        getAgentName={getAgentName}
        decisionRequestByMessage={decisionRequestByMessage}
        decisionReplyKey={decisionReplyKey}
        onDecisionOptionReply={handleDecisionOptionReply}
        onDecisionManualDraft={handleDecisionManualDraft}
        streamingMessage={streamingMessage}
        messagesEndRef={messagesEndRef}
      />

      {onSelectAgent ? (
        <MobileBottomSheet
          open={agentPickerOpen}
          onClose={() => setAgentPickerOpen(false)}
          title={tr("에이전트 선택", "Select agent", "エージェント選択", "选择代理", "Agent auswählen")}
        >
          <ul className="flex flex-col gap-1 py-2">
            <li>
              <button
                type="button"
                onClick={() => {
                  onSelectAgent(null);
                  setAgentPickerOpen(false);
                }}
                className={`flex w-full min-h-[44px] items-center gap-3 rounded-lg px-3 py-2 text-left ${
                  !selectedAgent ? "bg-retro-green/15 text-retro-green" : ""
                }`}
                style={{ color: !selectedAgent ? undefined : "var(--th-text-primary)" }}
              >
                <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-yellow-500/20 text-base">
                  📢
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-semibold">
                    {tr(
                      "브로드캐스트 (전체)",
                      "Broadcast (all agents)",
                      "ブロードキャスト (全員)",
                      "广播（全部代理）",
                      "Rundruf (alle Agenten)",
                    )}
                  </span>
                  <span className="truncate text-[11px]" style={{ color: "var(--th-text-secondary)" }}>
                    {tr(
                      "모든 에이전트에게 전달됩니다",
                      "Sent to all agents",
                      "すべてのエージェントに送信されます",
                      "将发送给所有代理",
                      "Wird an alle Agenten gesendet",
                    )}
                  </span>
                </span>
              </button>
            </li>
            {groupedAgents.map((group) => (
              <li key={group.label} className="pt-2">
                <div
                  className="px-3 pb-1 text-[10px] uppercase tracking-wider"
                  style={{ color: "var(--th-text-muted)" }}
                >
                  {group.label}
                </div>
                <ul className="flex flex-col">
                  {group.items.map((a) => {
                    const isActive = selectedAgent?.id === a.id;
                    return (
                      <li key={a.id}>
                        <button
                          type="button"
                          onClick={() => {
                            onSelectAgent(a);
                            setAgentPickerOpen(false);
                          }}
                          className={`flex w-full min-h-[44px] items-center gap-3 rounded-lg px-3 py-2 text-left ${
                            isActive ? "bg-retro-green/15 text-retro-green" : ""
                          }`}
                          style={{ color: isActive ? undefined : "var(--th-text-primary)" }}
                        >
                          <div className="relative flex-shrink-0">
                            <AgentAvatar agent={a} spriteMap={spriteMap} size={32} />
                            <span
                              className={`absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border-2 ${
                                STATUS_COLORS[a.status] ?? "bg-[var(--text-muted)]"
                              }`}
                              style={{ borderColor: "var(--th-bg-primary)" }}
                            />
                          </div>
                          <div className="flex min-w-0 flex-1 flex-col">
                            <div className="flex items-center gap-1.5">
                              <span className="truncate text-sm font-semibold">{getAgentName(a)}</span>
                              <span
                                className="flex-shrink-0 rounded px-1.5 py-0.5 text-[10px]"
                                style={{
                                  background: "var(--th-bg-surface-hover)",
                                  color: "var(--th-text-secondary)",
                                }}
                              >
                                {getRoleLabel(a.role)}
                              </span>
                            </div>
                            <div
                              className="mt-0.5 flex items-center gap-1 truncate text-[11px]"
                              style={{ color: "var(--th-text-secondary)" }}
                            >
                              <span className="truncate">{group.label}</span>
                              <span style={{ color: "var(--th-text-muted)" }}>·</span>
                              <span>{getStatusLabel(a.status)}</span>
                            </div>
                          </div>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ul>
        </MobileBottomSheet>
      ) : null}

      <ProjectFlowDialog
        open={projectFlowOpen}
        step={projectFlowStep}
        isDirectivePending={isDirectivePending}
        pendingContent={pendingSend?.content ?? ""}
        projectLoading={projectLoading}
        projectItems={projectItems}
        selectedProject={selectedProject}
        existingProjectInput={existingProjectInput}
        existingProjectError={existingProjectError}
        newProjectName={newProjectName}
        newProjectPath={newProjectPath}
        newProjectGoal={newProjectGoal}
        projectSaving={projectSaving}
        canCreateProject={canCreateProject}
        tr={tr}
        onClose={closeProjectFlow}
        onChooseExisting={handleChooseExistingProject}
        onChooseNew={() => setProjectFlowStep("new")}
        onBackToChoose={() => setProjectFlowStep("choose")}
        onSelectExistingProject={handleSelectExistingProject}
        onExistingProjectInputChange={handleExistingProjectInputChange}
        onApplyExistingProjectSelection={applyExistingProjectSelection}
        newProjectError={newProjectError}
        onNewProjectNameChange={setNewProjectName}
        onNewProjectPathChange={(v) => {
          setNewProjectPath(v);
          if (newProjectError) setNewProjectError("");
        }}
        onNewProjectGoalChange={setNewProjectGoal}
        onCreateProject={() => {
          void handleCreateProject();
        }}
        onConfirm={handleConfirmProject}
      />

      {/* Composer with safe-area padding */}
      <div style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
        <ChatComposer
          mode={mode}
          input={input}
          selectedAgent={selectedAgent}
          isDirectiveMode={isDirectiveMode}
          isAnnouncementMode={isAnnouncementMode}
          tr={tr}
          getAgentName={getAgentName}
          textareaRef={textareaRef}
          onModeChange={setMode}
          onInputChange={setInput}
          onSend={handleSend}
          onKeyDown={handleKeyDown}
        />
      </div>
    </div>
  );
}

export default MobileChatPanel;
