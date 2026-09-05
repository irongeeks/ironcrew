import type { View } from "./types";
import type { UiLanguage } from "../i18n";

// viewTitle labels arrive with an emoji prefix for the desktop top bar
// (e.g. "⚡ Operations"). On the narrow mobile header those prefixes make the
// title truncate to "OPERAT..." — strip them so truncation only happens when
// genuinely needed.
function stripEmojiPrefix(s: string): string {
  return s.replace(/^[^\p{L}\p{N}]+/u, "").trim();
}

interface MobileHeaderLabels {
  viewTitle: string;
  announcementLabel: string;
  roomManagerLabel: string;
  reportLabel: string;
  tasksPrimaryLabel: string;
  agentStatusLabel: string;
  decisionLabel: string;
}

interface MobileHeaderProps {
  labels: MobileHeaderLabels;
  showLegacyActions?: boolean;
  connected: boolean;
  uiLanguage: string;
  languageLabel: string;
  theme: "light" | "dark";
  decisionInboxLoading: boolean;
  decisionInboxCount: number;
  mobileHeaderMenuOpen: boolean;
  setMobileHeaderMenuOpen: (open: boolean) => void;
  onChangeView: (view: View) => void;
  onLanguageChange: (lang: UiLanguage) => void;
  onOpenDecisionInbox: () => void;
  onOpenAnnouncement: () => void;
  onOpenAgentStatus: () => void;
  onOpenReportHistory: () => void;
  onOpenRoomManager: () => void;
  toggleTheme: () => void;
  setMobileNavOpen: (open: boolean) => void;
}

export default function MobileHeader({
  labels,
  showLegacyActions = true,
  connected,
  uiLanguage,
  languageLabel,
  theme,
  decisionInboxLoading,
  decisionInboxCount,
  mobileHeaderMenuOpen,
  setMobileHeaderMenuOpen,
  onChangeView,
  onLanguageChange,
  onOpenDecisionInbox,
  onOpenAnnouncement,
  onOpenAgentStatus,
  onOpenReportHistory,
  onOpenRoomManager,
  toggleTheme,
  setMobileNavOpen: _setMobileNavOpen,
}: MobileHeaderProps) {
  return (
    <header
      className="sticky top-0 z-30 flex shrink-0 h-14 items-center justify-between px-3 lg:hidden"
      style={{ background: "var(--th-bg-header)", borderBottom: "1px solid var(--th-border)" }}
    >
      <button
        type="button"
        onClick={() => onChangeView("office")}
        className="flex h-11 w-11 items-center justify-center rounded"
        aria-label="IronCrew home"
        title="IronCrew"
      >
        <picture>
          <source media="(prefers-color-scheme: dark)" srcSet="/assets/ironcrew-logo-white.svg" />
          <source media="(prefers-color-scheme: light)" srcSet="/assets/ironcrew-logo-black.svg" />
          <img src="/assets/ironcrew-favicon.png" alt="IronCrew" width={32} height={32} />
        </picture>
      </button>
      <div className="min-w-0 flex-1 px-2 text-center">
        <p
          className="truncate"
          style={{
            color: "var(--th-text-primary)",
            fontFamily: "system-ui, sans-serif",
            fontSize: 10,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
          }}
        >
          {stripEmojiPrefix(labels.viewTitle)}
        </p>
      </div>
      <div
        className="relative inline-flex items-center gap-1.5 text-[10px]"
        style={{ color: "var(--th-text-secondary)" }}
      >
        {showLegacyActions && (
          <>
            <button
              type="button"
              onClick={onOpenDecisionInbox}
              disabled={decisionInboxLoading}
              className="inline-flex h-11 w-11 items-center justify-center rounded border border-retro-border bg-retro-dark/40 px-2 text-retro-text disabled:cursor-wait disabled:opacity-60"
              aria-label={labels.decisionLabel}
              title={labels.decisionLabel}
            >
              {decisionInboxLoading ? "\u23F3" : "\uD83E\uDDED"}
              {decisionInboxCount > 0 ? (
                <span className="ml-1 inline-flex min-w-[1rem] items-center justify-center rounded-full border border-retro-yellow px-1 text-[9px] leading-none text-retro-yellow">
                  {decisionInboxCount}
                </span>
              ) : null}
            </button>
            <button
              type="button"
              onClick={onOpenAnnouncement}
              className="inline-flex h-11 w-11 items-center justify-center rounded border border-retro-border bg-retro-dark/40 px-2 text-retro-text"
              aria-label={labels.announcementLabel}
              title={labels.announcementLabel}
            >
              {"\uD83D\uDCE2"}
            </button>
            <button
              type="button"
              onClick={() => onChangeView("tasks")}
              className="inline-flex h-11 w-11 items-center justify-center rounded border border-retro-border bg-retro-dark/40 px-2 text-retro-text"
              aria-label={labels.tasksPrimaryLabel}
              title={labels.tasksPrimaryLabel}
            >
              {"\uD83D\uDCCB"}
            </button>
          </>
        )}
        <select
          value={uiLanguage}
          onChange={(e) => onLanguageChange(e.target.value as UiLanguage)}
          className="hidden h-8 rounded border border-[var(--th-border)] px-1.5 text-xs outline-none sm:block"
          style={{ background: "var(--th-input-bg)", color: "var(--th-text-primary)" }}
          aria-label={languageLabel}
        >
          <option value="ko">KO</option>
          <option value="en">EN</option>
          <option value="ja">JA</option>
          <option value="zh">ZH</option>
          <option value="de">DE</option>
        </select>
        <span className={`h-2.5 w-2.5 ${connected ? "bg-retro-green" : "bg-retro-red"}`} />
        <span>{connected ? "LIVE" : "OFF"}</span>
        <button
          type="button"
          onClick={() => setMobileHeaderMenuOpen(!mobileHeaderMenuOpen)}
          className="inline-flex h-11 w-11 items-center justify-center rounded border border-[var(--th-border)] bg-[var(--th-bg-surface)] text-[var(--th-text-secondary)]"
          aria-label="More actions"
        >
          {"\u22EF"}
        </button>
        {mobileHeaderMenuOpen && (
          <>
            <button
              className="fixed inset-0 z-40"
              onClick={() => setMobileHeaderMenuOpen(false)}
              aria-label="Close menu"
            />
            <div
              className="absolute right-0 top-full z-50 mt-1 min-w-[190px] rounded py-1"
              style={{
                background: "var(--th-card-bg)",
                border: "1px solid var(--th-card-border)",
                borderRadius: "var(--radius-md)",
                boxShadow: "var(--shadow-modal)",
              }}
            >
              <button
                type="button"
                onClick={() => {
                  onChangeView("tasks");
                  setMobileHeaderMenuOpen(false);
                }}
                className="block w-full px-3 py-2 text-left text-xs transition-colors hover:bg-[var(--th-bg-surface-hover)]"
                style={{ color: "var(--th-text-primary)" }}
              >
                {"\uD83D\uDCCB"} {labels.tasksPrimaryLabel}
              </button>
              {showLegacyActions && (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      onOpenAgentStatus();
                      setMobileHeaderMenuOpen(false);
                    }}
                    className="block w-full px-3 py-2 text-left text-xs transition-colors hover:bg-[var(--th-bg-surface-hover)]"
                    style={{ color: "var(--th-text-primary)" }}
                  >
                    {"\uD83D\uDEE0"} {labels.agentStatusLabel}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      onOpenReportHistory();
                      setMobileHeaderMenuOpen(false);
                    }}
                    className="block w-full px-3 py-2 text-left text-xs transition-colors hover:bg-[var(--th-bg-surface-hover)]"
                    style={{ color: "var(--th-text-primary)" }}
                  >
                    {labels.reportLabel}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      onOpenRoomManager();
                      setMobileHeaderMenuOpen(false);
                    }}
                    className="block w-full px-3 py-2 text-left text-xs transition-colors hover:bg-[var(--th-bg-surface-hover)]"
                    style={{ color: "var(--th-text-primary)" }}
                  >
                    {labels.roomManagerLabel}
                  </button>
                </>
              )}
              <button
                type="button"
                onClick={() => {
                  toggleTheme();
                  setMobileHeaderMenuOpen(false);
                }}
                className="block w-full px-3 py-2 text-left text-xs transition-colors hover:bg-[var(--th-bg-surface-hover)]"
                style={{ borderTop: "1px solid var(--th-border)", color: "var(--th-text-primary)" }}
              >
                {theme === "dark" ? "\u2600 Light Mode" : "\uD83C\uDF19 Dark Mode"}
              </button>
              <div className="px-3 py-2" style={{ borderTop: "1px solid var(--th-border)" }}>
                <label className="mb-1 block text-[10px] font-medium" style={{ color: "var(--th-text-muted)" }}>
                  {languageLabel}
                </label>
                <select
                  value={uiLanguage}
                  onChange={(e) => {
                    onLanguageChange(e.target.value as UiLanguage);
                    setMobileHeaderMenuOpen(false);
                  }}
                  className="h-8 w-full rounded border border-[var(--th-border)] px-1.5 text-xs outline-none"
                  style={{ background: "var(--th-input-bg)", color: "var(--th-text-primary)" }}
                  aria-label={languageLabel}
                >
                  <option value="ko">KO</option>
                  <option value="en">EN</option>
                  <option value="ja">JA</option>
                  <option value="zh">ZH</option>
                  <option value="de">DE</option>
                </select>
              </div>
            </div>
          </>
        )}
      </div>
    </header>
  );
}
