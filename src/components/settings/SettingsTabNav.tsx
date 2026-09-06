import { useEffect } from "react";
import type { SettingsTab, TFunction } from "./types";

interface SettingsTabNavProps {
  tab: SettingsTab;
  setTab: (tab: SettingsTab) => void;
  t: TFunction;
  isMobile: boolean;
  drawerOpen: boolean;
  onToggleDrawer: () => void;
}

const TAB_ITEMS: Array<{ key: SettingsTab; icon: string; label: (t: TFunction) => string }> = [
  {
    key: "general",
    icon: "⚙️",
    label: (t) => t({ en: "General", de: "Allgemein" }),
  },
  {
    key: "cli",
    icon: "🔧",
    label: (t) => t({ en: "CLI Tools", de: "CLI-Tools" }),
  },
  {
    key: "oauth",
    icon: "🔑",
    label: (t) => t({ en: "OAuth", de: "OAuth" }),
  },
  { key: "api", icon: "🔌", label: (t) => t({ en: "API", de: "API" }) },
  {
    key: "gateway",
    icon: "📡",
    label: (t) => t({ en: "Channel", de: "Kanal" }),
  },
  {
    key: "knowledge",
    icon: "📚",
    label: (t) => t({ en: "Knowledge", de: "Wissen" }),
  },
  {
    key: "comfyui",
    icon: "🎬",
    label: (t) => t({ en: "ComfyUI", de: "ComfyUI" }),
  },
  {
    key: "connectors",
    icon: "🔗",
    label: (t) => t({ en: "Connectors", de: "Connectors" }),
  },
  {
    key: "mcp",
    icon: "🧩",
    label: (t) => t({ en: "MCP", de: "MCP" }),
  },
  {
    key: "servers",
    icon: "🖥️",
    label: (t) => t({ en: "Servers", de: "Server" }),
  },
  {
    key: "workflow_packs",
    icon: "📦",
    label: (t) => t({ en: "Workflow Packs", de: "Workflow-Packs" }),
  },
  {
    key: "observability",
    icon: "📊",
    label: (t) => t({ en: "Observability", de: "Observability" }),
  },
];

function TabList({
  tab,
  setTab,
  t,
  onSelect,
}: {
  tab: SettingsTab;
  setTab: (tab: SettingsTab) => void;
  t: TFunction;
  onSelect?: () => void;
}) {
  return (
    <nav className="flex flex-col gap-0.5">
      {TAB_ITEMS.map((item) => (
        <button
          key={item.key}
          onClick={() => {
            setTab(item.key);
            onSelect?.();
          }}
          className={`flex min-h-10 items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
            tab === item.key
              ? "border-l-2 border-blue-400 text-blue-400"
              : "border-l-2 border-transparent hover:opacity-80"
          }`}
          style={
            tab === item.key
              ? { backgroundColor: "color-mix(in srgb, var(--th-card-bg) 80%, var(--th-border))" }
              : { color: "var(--th-text-secondary)" }
          }
        >
          <span className="w-5 text-center">{item.icon}</span>
          <span>{item.label(t)}</span>
        </button>
      ))}
    </nav>
  );
}

export default function SettingsTabNav({ tab, setTab, t, isMobile, drawerOpen, onToggleDrawer }: SettingsTabNavProps) {
  // Close drawer on Escape
  useEffect(() => {
    if (!drawerOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onToggleDrawer();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [drawerOpen, onToggleDrawer]);

  // Desktop: static sidebar
  if (!isMobile) {
    return (
      <div
        className="w-[220px] flex-shrink-0 overflow-y-auto pr-2"
        style={{ borderRight: "1px solid var(--th-border)" }}
      >
        <TabList tab={tab} setTab={setTab} t={t} />
      </div>
    );
  }

  // Mobile: header bar + drawer overlay
  const activeItem = TAB_ITEMS.find((item) => item.key === tab);

  return (
    <>
      {/* Mobile header with current tab + hamburger */}
      <button
        onClick={onToggleDrawer}
        aria-expanded={drawerOpen}
        aria-label={t({ en: "Settings menu", de: "Einstellungsmenü" })}
        className="flex min-h-11 w-full items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium"
        style={{
          backgroundColor: "var(--th-card-bg)",
          border: "1px solid var(--th-border)",
          color: "var(--th-text-secondary)",
        }}
      >
        <span>☰</span>
        <span>{activeItem?.icon}</span>
        <span>{activeItem?.label(t)}</span>
      </button>

      {/* Drawer overlay */}
      {drawerOpen && (
        <div className="fixed inset-0 z-50 flex" role="dialog" aria-modal="true">
          {/* Backdrop */}
          <div className="absolute inset-0 bg-black/50" role="presentation" onClick={onToggleDrawer} />
          {/* Drawer panel */}
          <div
            className="relative z-10 h-full w-[260px] overflow-y-auto p-4"
            style={{ backgroundColor: "var(--bg-base, var(--th-card-bg))" }}
          >
            <TabList tab={tab} setTab={setTab} t={t} onSelect={onToggleDrawer} />
          </div>
        </div>
      )}
    </>
  );
}
