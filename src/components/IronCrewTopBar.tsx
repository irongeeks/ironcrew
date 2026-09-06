import { useI18n } from "../i18n";
import { NAVIGATION_LABELS } from "../app/navigation-labels";
import { useEffect, useState } from "react";
import type { View } from "../app/types";
import type { UiLanguage } from "../i18n";
import type { WorkflowPackKey } from "../types";

type OfficePackOption = {
  key: WorkflowPackKey;
  label: string;
  summary: string;
  slug: string;
  accent: number;
};

interface IronCrewTopBarProps {
  view: View;
  onChangeView: (view: View) => void;
  language: UiLanguage;
  onLanguageChange: (language: UiLanguage) => void;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  decisionInboxCount: number;
  decisionInboxLoading: boolean;
  onOpenDecisionInbox: () => void;
  onOpenAnnouncement: () => void;
  onOpenAgentStatus: () => void;
  onOpenReportHistory: () => void;
  onOpenRoomManager: () => void;
  onNewMission: () => void;
  officePackControl?: {
    label: string;
    value: WorkflowPackKey;
    options: OfficePackOption[];
    onChange: (packKey: WorkflowPackKey) => void;
  } | null;
  connected?: boolean;
  setupStatus?: { required_ok: boolean; optional_ok: boolean; onboarding_completed: boolean } | null;
}

const NAV_TABS = Object.keys(NAVIGATION_LABELS) as (keyof typeof NAVIGATION_LABELS)[];

const LANGUAGE_CYCLE: UiLanguage[] = ["en", "de"];

export default function IronCrewTopBar({
  view,
  onChangeView,
  language,
  onLanguageChange,
  theme,
  onToggleTheme,
  decisionInboxCount,
  decisionInboxLoading,
  onOpenDecisionInbox,
  onOpenAnnouncement,
  onOpenAgentStatus,
  onOpenReportHistory,
  onOpenRoomManager,
  onNewMission,
  officePackControl,
  connected,
  setupStatus,
}: IronCrewTopBarProps) {
  const { t, locale } = useI18n(language);
  const showLegacyActions = view !== "office" && view !== "command" && view !== "tasks";
  const [time, setTime] = useState(new Date());
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);

  useEffect(() => {
    const timer = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const formatTime = (date: Date) =>
    date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", hour12: false });

  function cycleLanguage() {
    const idx = LANGUAGE_CYCLE.indexOf(language);
    const next = LANGUAGE_CYCLE[(idx + 1) % LANGUAGE_CYCLE.length];
    onLanguageChange(next);
  }

  const barStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    height: 54,
    minHeight: 54,
    maxHeight: 54,
    background: "var(--bg-elevated)",
    borderBottom: "1px solid var(--border)",
    padding: "0 20px",
    gap: 0,
    position: "relative",
    zIndex: 30,
    flexShrink: 0,
    userSelect: "none",
  };

  const dividerStyle: React.CSSProperties = {
    width: 1,
    height: 20,
    background: "var(--border)",
    flexShrink: 0,
    margin: "0 8px",
  };

  const ghostBtnBase: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: 36,
    height: 36,
    padding: 0,
    border: "none",
    borderRadius: 6,
    background: "transparent",
    cursor: "pointer",
    fontSize: 15,
    lineHeight: 1,
    color: "var(--text-muted)",
    flexShrink: 0,
    transition: "background 120ms, color 120ms",
    outline: "none",
  };

  return (
    <header style={barStyle}>
      {/* Logo */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          marginRight: 24,
          flexShrink: 0,
        }}
      >
        <div
          style={{
            position: "relative",
            flexShrink: 0,
          }}
        >
          <img
            src={theme === "dark" ? "/assets/ironcrew-logo-white.svg" : "/assets/ironcrew-logo-black.svg"}
            alt="IronCrew"
            style={{
              height: 38,
              width: "auto",
            }}
          />
          {/* Green pulse dot */}
          <span
            aria-hidden="true"
            style={{
              position: "absolute",
              bottom: -1,
              right: -1,
              width: 5,
              height: 5,
              borderRadius: "50%",
              background: "var(--accent)",
              boxShadow: "0 0 6px var(--accent-glow)",
              animation: "pulse-glow 3s ease-in-out infinite",
            }}
          />
        </div>
        <span
          style={{
            fontFamily: "system-ui, sans-serif",
            fontSize: 12,
            letterSpacing: "0.08em",
            color: "var(--text-primary)",
            whiteSpace: "nowrap",
          }}
        >
          IRONCREW
        </span>
      </div>

      {/* Nav tabs */}
      <nav
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          minWidth: 0,
          overflowX: "auto",
          flex: 1,
        }}
      >
        {NAV_TABS.map((tab) => {
          const isActive = view === tab;
          return (
            <button
              key={tab}
              type="button"
              onClick={() => onChangeView(tab)}
              style={{
                position: "relative",
                height: 36,
                margin: 2,
                padding: "0 10px",
                border: "none",
                borderRadius: 6,
                background: isActive ? "var(--accent-dim)" : "transparent",
                cursor: "pointer",
                fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
                fontSize: 10,
                fontWeight: 600,
                letterSpacing: "0.06em",
                color: isActive ? "var(--accent-text)" : "var(--text-muted)",
                whiteSpace: "nowrap",
                transition: "background 120ms, color 120ms",
                outline: "none",
                flexShrink: 0,
              }}
              onMouseEnter={(e) => {
                if (!isActive) {
                  (e.currentTarget as HTMLButtonElement).style.background = "var(--bg-surface-hover)";
                  (e.currentTarget as HTMLButtonElement).style.color = "var(--text-primary)";
                }
              }}
              onMouseLeave={(e) => {
                if (!isActive) {
                  (e.currentTarget as HTMLButtonElement).style.background = "transparent";
                  (e.currentTarget as HTMLButtonElement).style.color = "var(--text-muted)";
                }
              }}
            >
              {t(NAVIGATION_LABELS[tab]).toLocaleUpperCase(locale)}
              {tab === "settings" && setupStatus && !setupStatus.onboarding_completed && (
                <span
                  aria-label={t({ en: "Setup incomplete", de: "Einrichtung unvollständig" })}
                  style={{
                    position: "absolute",
                    top: 4,
                    right: 4,
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: !setupStatus.required_ok ? "#ef4444" : "#f59e0b",
                    pointerEvents: "none",
                  }}
                />
              )}
            </button>
          );
        })}
      </nav>

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* + NEW MISSION button */}
      <button
        type="button"
        onClick={onNewMission}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
          height: 36,
          padding: "0 12px",
          border: "1px solid var(--accent)",
          borderRadius: 6,
          background: "var(--accent-dim)",
          cursor: "pointer",
          fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: "0.06em",
          color: "var(--accent-text)",
          whiteSpace: "nowrap",
          flexShrink: 0,
          transition: "background 120ms, box-shadow 120ms",
          outline: "none",
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLButtonElement).style.background = "var(--accent-dim)";
          (e.currentTarget as HTMLButtonElement).style.boxShadow = "0 0 12px var(--accent-glow)";
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLButtonElement).style.background = "var(--accent-dim)";
          (e.currentTarget as HTMLButtonElement).style.boxShadow = "none";
        }}
      >
        {t({ en: "+ NEW MISSION", de: "+ NEUER AUFTRAG" })}
      </button>

      <div style={dividerStyle} />

      {showLegacyActions && (
        <>
          {/* Announcement button */}
          <button
            type="button"
            onClick={onOpenAnnouncement}
            aria-label={t({ en: "Announcement", de: "Ankündigung" })}
            title={t({ en: "Announcement", de: "Ankündigung" })}
            style={ghostBtnBase}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = "var(--bg-surface-hover)";
              (e.currentTarget as HTMLButtonElement).style.color = "var(--text-primary)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = "transparent";
              (e.currentTarget as HTMLButtonElement).style.color = "var(--text-muted)";
            }}
          >
            &#x1F4E2;
          </button>

          {/* Decision Inbox with badge */}
          <div style={{ position: "relative", display: "inline-flex" }}>
            <button
              type="button"
              onClick={onOpenDecisionInbox}
              disabled={decisionInboxLoading}
              aria-label={t({ en: "Decision Inbox", de: "Entscheidungen" })}
              title={t({ en: "Decision Inbox", de: "Entscheidungen" })}
              style={{
                ...ghostBtnBase,
                opacity: decisionInboxLoading ? 0.6 : 1,
                cursor: decisionInboxLoading ? "wait" : "pointer",
              }}
              onMouseEnter={(e) => {
                if (!decisionInboxLoading) {
                  (e.currentTarget as HTMLButtonElement).style.background = "var(--bg-surface-hover)";
                  (e.currentTarget as HTMLButtonElement).style.color = "var(--text-primary)";
                }
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background = "transparent";
                (e.currentTarget as HTMLButtonElement).style.color = "var(--text-muted)";
              }}
            >
              {decisionInboxLoading ? "\u23F3" : "\u{1F9ED}"}
            </button>
            {decisionInboxCount > 0 && (
              <span
                aria-label={t({
                  en: `${decisionInboxCount} decisions pending`,
                  de: `${decisionInboxCount} ausstehende Entscheidungen`,
                })}
                style={{
                  position: "absolute",
                  top: 5,
                  right: 5,
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: "var(--accent)",
                  boxShadow: "0 0 6px var(--accent-glow)",
                  pointerEvents: "none",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              />
            )}
          </div>
        </>
      )}

      {/* Pack selector */}
      {officePackControl && (
        <select
          value={officePackControl.value}
          onChange={(e) => officePackControl.onChange(e.target.value as WorkflowPackKey)}
          aria-label={officePackControl.label}
          title={officePackControl.label}
          style={{
            height: 36,
            padding: "0 6px",
            border: "1px solid var(--border)",
            borderRadius: 6,
            background: "var(--bg-surface)",
            color: "var(--text-muted)",
            cursor: "pointer",
            fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
            fontSize: 10,
            outline: "none",
            flexShrink: 0,
          }}
        >
          {officePackControl.options.map((option) => (
            <option key={option.key} value={option.key}>
              {option.slug} · {option.label}
            </option>
          ))}
        </select>
      )}

      {showLegacyActions && (
        <>
          {/* More Actions menu (⋯) — Agent Status, Report History, Room Manager */}
          <div style={{ position: "relative" }}>
            <button
              type="button"
              onClick={() => setMoreMenuOpen((prev) => !prev)}
              style={{ ...ghostBtnBase, fontSize: 18, letterSpacing: "1px" }}
              aria-label={t({ en: "More actions", de: "Weitere Aktionen" })}
              title={t({ en: "More actions", de: "Weitere Aktionen" })}
            >
              &#x22EF;
            </button>
            {moreMenuOpen && (
              <>
                <button
                  className="fixed inset-0 z-40"
                  onClick={() => setMoreMenuOpen(false)}
                  aria-label={t({ en: "Close menu", de: "Menü schließen" })}
                  style={{ background: "transparent", border: "none" }}
                />
                <div
                  style={{
                    position: "absolute",
                    right: 0,
                    top: "100%",
                    zIndex: 50,
                    marginTop: 4,
                    minWidth: 200,
                    padding: "6px 0",
                    background: "var(--bg-surface-solid)",
                    border: "1px solid var(--border)",
                    borderRadius: 10,
                    boxShadow: "var(--shadow-modal)",
                  }}
                >
                  {[
                    { label: t({ en: "Agent Status", de: "Agentenstatus" }), action: onOpenAgentStatus },
                    { label: t({ en: "Report History", de: "Berichtsverlauf" }), action: onOpenReportHistory },
                    { label: t({ en: "Room Manager", de: "Büroverwaltung" }), action: onOpenRoomManager },
                  ].map((item) => (
                    <button
                      key={item.label}
                      type="button"
                      onClick={() => {
                        item.action();
                        setMoreMenuOpen(false);
                      }}
                      style={{
                        display: "flex",
                        width: "100%",
                        alignItems: "center",
                        gap: 8,
                        padding: "8px 14px",
                        background: "transparent",
                        border: "none",
                        color: "var(--text-secondary)",
                        fontFamily: "'JetBrains Mono', monospace",
                        fontSize: 11,
                        cursor: "pointer",
                        textAlign: "left",
                        transition: "background 0.1s",
                      }}
                      onMouseEnter={(e) => {
                        (e.currentTarget as HTMLButtonElement).style.background = "var(--bg-surface-hover)";
                      }}
                      onMouseLeave={(e) => {
                        (e.currentTarget as HTMLButtonElement).style.background = "transparent";
                      }}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </>
      )}

      <div style={dividerStyle} />

      {/* Theme toggle */}
      <button
        type="button"
        onClick={onToggleTheme}
        aria-label={
          theme === "dark"
            ? t({ en: "Switch to light mode", de: "Zum hellen Modus wechseln" })
            : t({ en: "Switch to dark mode", de: "Zum dunklen Modus wechseln" })
        }
        title={
          theme === "dark"
            ? t({ en: "Switch to light mode", de: "Zum hellen Modus wechseln" })
            : t({ en: "Switch to dark mode", de: "Zum dunklen Modus wechseln" })
        }
        style={ghostBtnBase}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLButtonElement).style.background = "var(--bg-surface-hover)";
          (e.currentTarget as HTMLButtonElement).style.color = "var(--text-primary)";
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLButtonElement).style.background = "transparent";
          (e.currentTarget as HTMLButtonElement).style.color = "var(--text-muted)";
        }}
      >
        {theme === "dark" ? "\u2600\uFE0F" : "\uD83C\uDF19"}
      </button>

      {/* Language cycle button */}
      <button
        type="button"
        onClick={cycleLanguage}
        aria-label={t({
          en: `Current language: ${language.toUpperCase()}. Click to switch to German.`,
          de: "Aktuelle Sprache: DE. Klicken, um zu Englisch zu wechseln.",
        })}
        title={t({ en: "Language: English", de: "Sprache: Deutsch" })}
        style={{
          ...ghostBtnBase,
          width: "auto",
          padding: "0 8px",
          fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: "0.06em",
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLButtonElement).style.background = "var(--bg-surface-hover)";
          (e.currentTarget as HTMLButtonElement).style.color = "var(--text-primary)";
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLButtonElement).style.background = "transparent";
          (e.currentTarget as HTMLButtonElement).style.color = "var(--text-muted)";
        }}
      >
        {language.toUpperCase()}
      </button>

      {/* Clock */}
      <span
        style={{
          fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
          fontSize: 11,
          fontWeight: 600,
          color: "var(--text-primary)",
          letterSpacing: "0.04em",
          minWidth: 42,
          textAlign: "right",
          flexShrink: 0,
          paddingLeft: 4,
        }}
      >
        {formatTime(time)}
      </span>

      {/* Connection indicator (optional) */}
      {connected !== undefined && (
        <span
          aria-label={connected ? t({ en: "Connected", de: "Verbunden" }) : t({ en: "Disconnected", de: "Getrennt" })}
          title={connected ? t({ en: "Connected", de: "Verbunden" }) : t({ en: "Disconnected", de: "Getrennt" })}
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: connected ? "var(--accent)" : "#EF4444",
            boxShadow: connected ? "0 0 6px var(--accent-glow)" : "0 0 6px rgba(239,68,68,0.4)",
            flexShrink: 0,
            marginLeft: 8,
          }}
        />
      )}
    </header>
  );
}
