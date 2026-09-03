import type { MessagingContext } from "../types/runtime-context-domains.ts";

/**
 * Dependencies for MessagingContext — pass-through from runtimeContext.
 *
 * All functions here are closures created inside barrel modules
 * (collab.ts, workflow/core.ts, etc.) that close over runtimeContext.
 * Until those modules are refactored to accept narrow deps, we pass
 * the functions through from the fully-wired runtimeContext.
 */
export interface MessagingDeps {
  ROLE_LABEL: MessagingContext["ROLE_LABEL"];
  ROLE_LABEL_L10N: MessagingContext["ROLE_LABEL_L10N"];
  SUPPORTED_LANGS: MessagingContext["SUPPORTED_LANGS"];

  classifyIntent: MessagingContext["classifyIntent"];
  createDirectAgentTaskAndRun: MessagingContext["createDirectAgentTaskAndRun"];
  detectLang: MessagingContext["detectLang"];
  fallbackTurnReply: MessagingContext["fallbackTurnReply"];
  generateAnnouncementReply: MessagingContext["generateAnnouncementReply"];
  generateChatReply: MessagingContext["generateChatReply"];
  getFlairs: MessagingContext["getFlairs"];
  getPreferredLanguage: MessagingContext["getPreferredLanguage"];
  getRoleLabel: MessagingContext["getRoleLabel"];
  isLang: MessagingContext["isLang"];
  l: MessagingContext["l"];
  localeInstruction: MessagingContext["localeInstruction"];
  normalizeConversationReply: MessagingContext["normalizeConversationReply"];
  normalizeTextField: MessagingContext["normalizeTextField"];
  pickL: MessagingContext["pickL"];
  pickRandom: MessagingContext["pickRandom"];
  resolveLang: MessagingContext["resolveLang"];
  scheduleAgentReply: MessagingContext["scheduleAgentReply"];
  scheduleAnnouncementReplies: MessagingContext["scheduleAnnouncementReplies"];
  sendAgentMessage: MessagingContext["sendAgentMessage"];
  shouldTreatDirectChatAsTask: MessagingContext["shouldTreatDirectChatAsTask"];
  resetDirectChatState: MessagingContext["resetDirectChatState"];
}

/**
 * Creates a MessagingContext by forwarding all properties from deps.
 *
 * This is a transitional pass-through factory. As individual source modules
 * (language-policy.ts, chat-response.ts, etc.) are refactored to accept
 * narrow deps, their functions will be imported and composed here directly
 * — mirroring what OAuthContext already does with createOAuthTools().
 */
export function createMessagingContext(deps: MessagingDeps): MessagingContext {
  return {
    ROLE_LABEL: deps.ROLE_LABEL,
    ROLE_LABEL_L10N: deps.ROLE_LABEL_L10N,
    SUPPORTED_LANGS: deps.SUPPORTED_LANGS,

    classifyIntent: deps.classifyIntent,
    createDirectAgentTaskAndRun: deps.createDirectAgentTaskAndRun,
    detectLang: deps.detectLang,
    fallbackTurnReply: deps.fallbackTurnReply,
    generateAnnouncementReply: deps.generateAnnouncementReply,
    generateChatReply: deps.generateChatReply,
    getFlairs: deps.getFlairs,
    getPreferredLanguage: deps.getPreferredLanguage,
    getRoleLabel: deps.getRoleLabel,
    isLang: deps.isLang,
    l: deps.l,
    localeInstruction: deps.localeInstruction,
    normalizeConversationReply: deps.normalizeConversationReply,
    normalizeTextField: deps.normalizeTextField,
    pickL: deps.pickL,
    pickRandom: deps.pickRandom,
    resolveLang: deps.resolveLang,
    scheduleAgentReply: deps.scheduleAgentReply,
    scheduleAnnouncementReplies: deps.scheduleAnnouncementReplies,
    sendAgentMessage: deps.sendAgentMessage,
    shouldTreatDirectChatAsTask: deps.shouldTreatDirectChatAsTask,
    resetDirectChatState: deps.resetDirectChatState,
  };
}
