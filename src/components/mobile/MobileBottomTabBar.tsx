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

const PRIMARY_TABS: Array<{ key: View | "chat" | "more"; label: string; icon: string }> = [
  { key: "office", label: "Office", icon: "🏢" },
  { key: "tasks", label: "Tasks", icon: "📋" },
  { key: "chat", label: "Chat", icon: "💬" },
  { key: "operations", label: "Ops", icon: "⚙️" },
  { key: "more", label: "More", icon: "···" },
];

const MORE_ITEMS: Array<{ key: View; label: string; icon: string }> = [
  { key: "agents", label: "Roster", icon: "👥" },
  { key: "skills", label: "Library", icon: "📚" },
  { key: "projects", label: "Projects", icon: "📁" },
  { key: "schedules", label: "Schedules", icon: "📅" },
  { key: "settings", label: "Settings", icon: "⚙️" },
];

export function MobileBottomTabBar({
  activeView,
  onChangeView,
  onOpenChat,
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
    } else if (key === "chat") {
      onOpenChat?.();
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
              className={`min-h-[56px] flex flex-col items-center justify-center gap-1 ${
                isActive(tab.key) ? "bg-retro-green/15 text-retro-green" : ""
              }`}
              style={{
                ...(!isActive(tab.key) ? { color: "var(--th-text-secondary)" } : undefined),
                fontFamily: "'Press Start 2P', monospace",
                fontSize: 8,
                letterSpacing: "0.06em",
              }}
            >
              <span className="text-base leading-none" style={{ fontFamily: "system-ui, sans-serif" }}>
                {tab.icon}
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
                  fontFamily: "'Press Start 2P', monospace",
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
                {item.icon}
              </span>
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      </MobileBottomSheet>
    </>
  );
}
