import { useState } from "react";
import type { View } from "../app/types";

interface LeftNavProps {
  view: View;
  onChangeView: (view: View) => void;
  connected: boolean;
}

const NAV_ITEMS: { key: View; label: string; icon: React.ReactNode }[] = [
  {
    key: "office",
    label: "OFFICE",
    icon: (
      <svg
        width="20"
        height="20"
        viewBox="0 0 18 18"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M3 16V5l6-3 6 3v11" />
        <rect x="6" y="7" width="2.5" height="2.5" rx="0.5" fill="currentColor" opacity="0.5" />
        <rect x="10" y="7" width="2.5" height="2.5" rx="0.5" fill="currentColor" opacity="0.5" />
        <path d="M7.5 16v-3.5h3V16" />
      </svg>
    ),
  },
  {
    key: "operations",
    label: "OPS",
    icon: (
      <svg
        width="20"
        height="20"
        viewBox="0 0 18 18"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M2 4h14" />
        <path d="M2 9h14" />
        <path d="M2 14h14" />
        <circle cx="12" cy="4" r="1.5" fill="currentColor" />
        <circle cx="6" cy="9" r="1.5" fill="currentColor" />
        <circle cx="10" cy="14" r="1.5" fill="currentColor" />
      </svg>
    ),
  },
  {
    key: "tasks",
    label: "TASKS",
    icon: (
      <svg
        width="20"
        height="20"
        viewBox="0 0 18 18"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="2" y="2" width="14" height="14" rx="2" />
        <path d="M6 6l2 2 4-4" />
        <path d="M6 12h6" opacity="0.5" />
      </svg>
    ),
  },
  {
    key: "agents",
    label: "ROSTER",
    icon: (
      <svg
        width="20"
        height="20"
        viewBox="0 0 18 18"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="7" cy="5.5" r="2.5" />
        <path d="M2 15c0-3 2.5-5 5-5s5 2 5 5" />
        <circle cx="13" cy="6.5" r="1.8" opacity="0.5" />
        <path d="M13 10c2 0 3.5 1.5 3.5 3.5" opacity="0.5" />
      </svg>
    ),
  },
  {
    key: "skills",
    label: "LIBRARY",
    icon: (
      <svg
        width="20"
        height="20"
        viewBox="0 0 18 18"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M3 2v14" />
        <path d="M6 2v14" />
        <path d="M10 2l-1 14" />
        <path d="M14 2v14" />
        <path d="M2 15h13" />
        <path d="M2 3h13" opacity="0.4" />
      </svg>
    ),
  },
  {
    key: "projects",
    label: "PROJECTS",
    icon: (
      <svg
        width="20"
        height="20"
        viewBox="0 0 18 18"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M2 5l2-2h4l2 2h6v10H2V5z" />
        <path d="M2 8h14" opacity="0.35" />
      </svg>
    ),
  },
  {
    key: "schedules",
    label: "SCHEDULES",
    icon: (
      <svg
        width="20"
        height="20"
        viewBox="0 0 20 20"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="10" cy="10" r="8" />
        <path d="M10 6v4l3 3" />
      </svg>
    ),
  },
  {
    key: "settings",
    label: "CONFIG",
    icon: (
      <svg
        width="20"
        height="20"
        viewBox="0 0 18 18"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="9" cy="9" r="2.5" />
        <path d="M9 2v2M9 14v2M2 9h2M14 9h2M4.2 4.2l1.4 1.4M12.4 12.4l1.4 1.4M4.2 13.8l1.4-1.4M12.4 5.6l1.4-1.4" />
      </svg>
    ),
  },
];

function LogoIcon() {
  return (
    <img
      src="/assets/octooffice-logo-white.svg"
      alt="OctoOffice"
      style={{
        width: 40,
        height: 40,
        flexShrink: 0,
      }}
    />
  );
}

export default function RetroSidebar({ view, onChangeView, connected }: LeftNavProps) {
  const [expanded, setExpanded] = useState(true);

  return (
    <nav
      className="flex flex-col shrink-0 h-full relative"
      style={{
        width: expanded ? 200 : 64,
        background: "var(--bg-base)",
        padding: "16px 0",
        transition: "width 300ms cubic-bezier(0.4, 0, 0.2, 1)",
        overflow: "hidden",
        zIndex: 50,
      }}
    >
      {/* Top gradient overlay */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: "30%",
          background: "linear-gradient(180deg, var(--bg-surface) 0%, transparent 100%)",
          pointerEvents: "none",
          zIndex: 0,
        }}
      />

      {/* Right edge fade (replaces border) */}
      <div
        style={{
          position: "absolute",
          top: 0,
          right: -12,
          width: 12,
          height: "100%",
          background: "linear-gradient(90deg, var(--bg-base), transparent)",
          pointerEvents: "none",
          zIndex: 1,
        }}
      />

      {/* Logo */}
      <div
        className="flex items-center shrink-0"
        style={{
          height: 48,
          padding: "0 18px",
          marginBottom: 20,
          position: "relative",
          zIndex: 1,
          gap: 12,
        }}
      >
        <div
          style={{
            flexShrink: 0,
            filter: "drop-shadow(0 0 8px var(--accent-dim))",
          }}
        >
          <LogoIcon />
        </div>
        <span
          style={{
            fontFamily: "Inter, -apple-system, sans-serif",
            fontSize: 12,
            fontWeight: 600,
            letterSpacing: "0.12em",
            color: "var(--text-secondary)",
            whiteSpace: "nowrap",
            opacity: expanded ? 1 : 0,
            transition: "opacity 200ms ease",
            transitionDelay: expanded ? "100ms" : "0ms",
          }}
        >
          OCTOOFFICE
        </span>
      </div>

      {/* Nav items */}
      <nav
        aria-label="Main navigation"
        className="flex flex-col flex-1"
        style={{
          padding: "0 12px",
          gap: 2,
          position: "relative",
          zIndex: 1,
        }}
      >
        {NAV_ITEMS.map((item) => {
          const isActive = view === item.key;
          return (
            <button
              key={item.key}
              aria-label={`Navigate to ${item.label}`}
              aria-current={isActive ? "page" : undefined}
              onClick={() => onChangeView(item.key)}
              className="flex items-center text-left w-full"
              style={{
                height: 40,
                padding: "0 0 0 0",
                borderRadius: 10,
                border: "none",
                outline: "none",
                cursor: "pointer",
                background: "transparent",
                transition: "all 150ms ease",
                position: "relative",
              }}
              onMouseEnter={(e) => {
                if (!isActive) {
                  const iconWrap = e.currentTarget.querySelector("[data-icon-wrap]") as HTMLElement;
                  if (iconWrap) {
                    iconWrap.style.opacity = "0.6";
                    iconWrap.style.background = "var(--bg-surface-hover)";
                  }
                }
              }}
              onMouseLeave={(e) => {
                if (!isActive) {
                  const iconWrap = e.currentTarget.querySelector("[data-icon-wrap]") as HTMLElement;
                  if (iconWrap) {
                    iconWrap.style.opacity = "0.35";
                    iconWrap.style.background = "transparent";
                  }
                }
              }}
            >
              {/* Icon container */}
              <div
                data-icon-wrap=""
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 10,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                  transition: "all 200ms ease",
                  color: isActive ? "#ffffff" : "var(--text-secondary)",
                  opacity: isActive ? 1 : 0.35,
                  filter: isActive ? "none" : "grayscale(100%)",
                  background: isActive ? "linear-gradient(135deg, var(--accent), #10B981)" : "transparent",
                  boxShadow: isActive ? "0 0 20px var(--accent-dim), 0 2px 8px var(--accent-subtle)" : "none",
                }}
              >
                {item.icon}
              </div>

              {/* Label */}
              <span
                style={{
                  fontFamily: "Inter, -apple-system, sans-serif",
                  fontSize: 11,
                  fontWeight: 500,
                  letterSpacing: "0.05em",
                  color: isActive ? "var(--text-primary)" : "var(--text-muted)",
                  whiteSpace: "nowrap",
                  marginLeft: 12,
                  opacity: expanded ? 1 : 0,
                  transition: "opacity 200ms ease",
                  transitionDelay: expanded ? "80ms" : "0ms",
                }}
              >
                {item.label}
              </span>
            </button>
          );
        })}
      </nav>

      {/* Collapse toggle */}
      <button
        type="button"
        aria-label={expanded ? "Collapse sidebar" : "Expand sidebar"}
        onClick={() => setExpanded((prev) => !prev)}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: expanded ? "flex-start" : "center",
          padding: expanded ? "0 24px" : "0",
          gap: 8,
          height: 32,
          width: "100%",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          position: "relative",
          zIndex: 1,
          marginBottom: 4,
          transition: "all 300ms cubic-bezier(0.4, 0, 0.2, 1)",
        }}
      >
        <span
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 20,
            height: 20,
            borderRadius: 4,
            flexShrink: 0,
            color: "var(--text-muted)",
            fontSize: 12,
            transition: "transform 200ms ease",
            transform: expanded ? "rotate(0deg)" : "rotate(180deg)",
          }}
        >
          ‹
        </span>
        <span
          style={{
            fontFamily: "Inter, -apple-system, sans-serif",
            fontSize: 9,
            fontWeight: 500,
            letterSpacing: "0.08em",
            color: "var(--text-muted)",
            whiteSpace: "nowrap",
            opacity: expanded ? 1 : 0,
            transition: "opacity 200ms ease",
            transitionDelay: expanded ? "80ms" : "0ms",
          }}
        >
          COLLAPSE
        </span>
      </button>

      {/* Connection status */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: expanded ? "flex-start" : "center",
          padding: expanded ? "0 24px" : "0",
          gap: 8,
          height: 32,
          position: "relative",
          zIndex: 1,
          transition: "all 300ms cubic-bezier(0.4, 0, 0.2, 1)",
        }}
      >
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            flexShrink: 0,
            background: connected ? "var(--accent)" : "#ef4444",
            boxShadow: connected
              ? "0 0 8px var(--accent-dim), 0 0 2px var(--accent-glow)"
              : "0 0 8px rgba(239,68,68,0.3), 0 0 2px rgba(239,68,68,0.5)",
            animation: connected ? "pulse-glow 3s ease-in-out infinite" : "none",
          }}
        />
        <span
          style={{
            fontFamily: "Inter, -apple-system, sans-serif",
            fontSize: 9,
            fontWeight: 500,
            letterSpacing: "0.08em",
            color: connected ? "var(--accent-glow)" : "rgba(239,68,68,0.6)",
            whiteSpace: "nowrap",
            opacity: expanded ? 1 : 0,
            transition: "opacity 200ms ease",
            transitionDelay: expanded ? "80ms" : "0ms",
          }}
        >
          {connected ? "ONLINE" : "OFFLINE"}
        </span>
      </div>
    </nav>
  );
}
