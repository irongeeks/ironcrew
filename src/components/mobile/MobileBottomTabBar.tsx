import { useState } from "react";
import type { View } from "../../app/types";
import type { WorkflowPackKey } from "../../types";
import { MobileBottomSheet } from "./MobileBottomSheet";

interface MobileBottomTabBarProps {
  activeView: View;
  onChangeView: (view: View) => void;
  onOpenChat?: () => void;
  officePackKey?: WorkflowPackKey;
  officePackLabel?: string;
  officePackOptions?: Array<{ key: WorkflowPackKey; label: string; slug: string }>;
  onChangeOfficeWorkflowPack?: (key: WorkflowPackKey) => void;
}

const PRIMARY_TABS: Array<{ key: View | "more"; label: string; icon: string }> = [
  { key: "office", label: "Office", icon: "office" },
  { key: "tasks", label: "Tasks", icon: "tasks" },
  { key: "command", label: "CEO Chat", icon: "message" },
  { key: "operations", label: "Ops", icon: "settings" },
  { key: "more", label: "More", icon: "more" },
];

const MORE_ITEMS: Array<{ key: View; label: string; icon: string }> = [
  { key: "agents", label: "Roster", icon: "agents" },
  { key: "skills", label: "Library", icon: "skills" },
  { key: "projects", label: "Projects", icon: "projects" },
  { key: "schedules", label: "Schedules", icon: "schedules" },
  { key: "settings", label: "Settings", icon: "settings" },
];

export function MobileBottomTabBar({
  activeView,
  onChangeView,
  onOpenChat: _onOpenChat,
  officePackKey,
  officePackLabel,
  officePackOptions,
  onChangeOfficeWorkflowPack,
}: MobileBottomTabBarProps) {
  const [moreOpen, setMoreOpen] = useState(false);

  const isActive = (key: string) => {
    if (key === "more") return MORE_ITEMS.some((item) => item.key === activeView);
    return key === activeView;
  };

  const handleTabPress = (key: string) => {
    if (key === "more") {
      setMoreOpen(true);
    } else {
      onChangeView(key as View);
    }
  };

  const handleMoreItemPress = (key: View) => {
    setMoreOpen(false);
    onChangeView(key);
  };

  const showPackSelector =
    !!officePackOptions && officePackOptions.length > 0 && !!onChangeOfficeWorkflowPack && !!officePackKey;

  return (
    <>
      <nav
        aria-label="Hauptnavigation"
        className="fixed inset-x-0 bottom-0 z-30"
        style={{
          background: "var(--th-bg-primary)",
          borderTop: "1px solid var(--th-border)",
          paddingBottom: "env(safe-area-inset-bottom)",
        }}
      >
        <div className="grid grid-cols-5">
          {PRIMARY_TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => handleTabPress(tab.key)}
              aria-current={isActive(tab.key) ? "page" : undefined}
              className={`min-h-[56px] flex flex-col items-center justify-center gap-1 ${
                isActive(tab.key) ? "bg-retro-green/15 text-retro-green" : ""
              }`}
              style={{
                ...(!isActive(tab.key) ? { color: "var(--th-text-secondary)" } : undefined),
                fontFamily: "system-ui, sans-serif",
                fontSize: 11,
                letterSpacing: "0.06em",
              }}
            >
              <span className="text-base leading-none" style={{ fontFamily: "system-ui, sans-serif" }}>
                <NavigationIcon name={tab.icon} />
              </span>
              <span>{tab.label}</span>
            </button>
          ))}
        </div>
      </nav>

      <MobileBottomSheet open={moreOpen} onClose={() => setMoreOpen(false)} title="More">
        <div className="flex flex-col gap-1 pb-4">
          {showPackSelector && (
            <div
              data-testid="more-sheet-pack-selector"
              className="mb-2 flex flex-col gap-2 rounded-lg px-3 py-3"
              style={{
                background: "var(--th-bg-surface)",
                border: "1px solid var(--th-border)",
              }}
            >
              <label
                htmlFor="more-sheet-office-pack-select"
                className="block"
                style={{
                  color: "var(--th-accent)",
                  fontFamily: "system-ui, sans-serif",
                  fontSize: 9,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                }}
              >
                {officePackLabel || "Workflow Pack"}
              </label>
              <select
                id="more-sheet-office-pack-select"
                aria-label={officePackLabel || "Workflow Pack"}
                value={officePackKey}
                onChange={(e) => {
                  onChangeOfficeWorkflowPack?.(e.target.value as WorkflowPackKey);
                  setMoreOpen(false);
                }}
                className="w-full rounded border px-3 text-sm outline-none"
                style={{
                  minHeight: 44,
                  background: "var(--th-input-bg)",
                  color: "var(--th-text-primary)",
                  borderColor: "var(--th-border)",
                  fontFamily: "'JetBrains Mono', monospace",
                }}
              >
                {officePackOptions!.map((option) => (
                  <option key={option.key} value={option.key}>
                    {option.slug} · {option.label}
                  </option>
                ))}
              </select>
            </div>
          )}
          {showPackSelector && <div aria-hidden className="mb-1 h-px" style={{ background: "var(--th-border)" }} />}
          {MORE_ITEMS.map((item) => (
            <button
              key={item.key}
              onClick={() => handleMoreItemPress(item.key)}
              className={`flex min-h-[48px] items-center gap-3 rounded-lg px-3 ${
                activeView === item.key ? "bg-retro-green/15 text-retro-green" : ""
              }`}
              style={{
                ...(activeView !== item.key ? { color: "var(--th-text-primary)" } : undefined),
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 13,
              }}
            >
              <span className="text-lg" style={{ fontFamily: "system-ui, sans-serif" }}>
                <NavigationIcon name={item.icon} />
              </span>
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      </MobileBottomSheet>
    </>
  );
}

const ICON_PATHS: Record<string, string> = {
  office: "M4 21V3h16v18M8 7h2m4 0h2M8 11h2m4 0h2M9 21v-6h6v6",
  tasks: "M9 5h12M9 12h12M9 19h12M3 5h1M3 12h1M3 19h1",
  message: "M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
  settings: "M3 7h18M3 17h18M8 4v6M16 14v6",
  more: "M5 12h1m5 0h1m5 0h1",
  agents: "M8 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M1 21v-3a7 7 0 0 1 14 0v3M17 4a4 4 0 0 1 0 8m1 3a5 5 0 0 1 5 5",
  skills: "M3 3h6v18H3zM12 3h6v18h-6zM3 7h6m3 0h6",
  projects: "M3 6h7l2 3h9v12H3z",
  schedules: "M3 5h18v16H3zM7 2v6m10-6v6M3 11h18",
};

function NavigationIcon({ name }: { name: string }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}
