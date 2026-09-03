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
    label: (t) => t({ ko: "일반 설정", en: "General", ja: "一般設定", zh: "General", de: "Allgemein" }),
  },
  {
    key: "cli",
    icon: "🔧",
    label: (t) => t({ ko: "CLI 도구", en: "CLI Tools", ja: "CLI ツール", zh: "CLI Tools", de: "CLI-Tools" }),
  },
  {
    key: "oauth",
    icon: "🔑",
    label: (t) => t({ ko: "OAuth 인증", en: "OAuth", ja: "OAuth 認証", zh: "OAuth", de: "OAuth" }),
  },
  { key: "api", icon: "🔌", label: (t) => t({ ko: "API 연동", en: "API", ja: "API 連携", zh: "API", de: "API" }) },
  {
    key: "gateway",
    icon: "📡",
    label: (t) => t({ ko: "채널 메시지", en: "Channel", ja: "チャネル", zh: "Channel", de: "Kanal" }),
  },
  {
    key: "knowledge",
    icon: "📚",
    label: (t) => t({ ko: "지식 베이스", en: "Knowledge", ja: "ナレッジ", zh: "Knowledge", de: "Wissen" }),
  },
  {
    key: "comfyui",
    icon: "🎬",
    label: (t) => t({ ko: "ComfyUI", en: "ComfyUI", ja: "ComfyUI", zh: "ComfyUI", de: "ComfyUI" }),
  },
  {
    key: "connectors",
    icon: "🔗",
    label: (t) => t({ ko: "커넥터", en: "Connectors", ja: "コネクター", zh: "Connectors", de: "Connectors" }),
  },
  {
    key: "mcp",
    icon: "🧩",
    label: (t) => t({ ko: "MCP", en: "MCP", ja: "MCP", zh: "MCP", de: "MCP" }),
  },
  {
    key: "servers",
    icon: "🖥️",
    label: (t) => t({ ko: "서버", en: "Servers", ja: "サーバー", zh: "Servers", de: "Server" }),
  },
  {
    key: "workflow_packs",
    icon: "📦",
    label: (t) =>
      t({
        ko: "워크플로우 팩",
        en: "Workflow Packs",
        ja: "ワークフロー パック",
        zh: "Workflow Packs",
        de: "Workflow-Packs",
      }),
  },
  {
    key: "observability",
    icon: "📊",
    label: (t) =>
      t({
        ko: "관찰 가능성",
        en: "Observability",
        ja: "オブザーバビリティ",
        zh: "Observability",
        de: "Observability",
      }),
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
        aria-label={t({
          ko: "설정 메뉴",
          en: "Settings menu",
          ja: "設定メニュー",
          zh: "设置菜单",
          de: "Einstellungsmenü",
        })}
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
