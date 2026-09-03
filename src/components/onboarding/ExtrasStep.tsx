import { useState } from "react";

interface ExtrasStepProps {
  onNext: () => void;
  onBack: () => void;
}

interface CardConfig {
  id: string;
  icon: string;
  title: string;
  subtitle: string;
  expandedContent: string;
}

const EXTRAS_CARDS: CardConfig[] = [
  {
    id: "github",
    icon: "🐙",
    title: "GitHub OAuth",
    subtitle: "Connect GitHub for repo import and Copilot auth",
    expandedContent: "→ Configure in Settings → API & Keys tab",
  },
  {
    id: "apikey",
    icon: "🔑",
    title: "API Key",
    subtitle: "Add API keys for cloud model providers (OpenAI, Anthropic…)",
    expandedContent: "→ Configure in Settings → API & Keys tab",
  },
  {
    id: "messenger",
    icon: "💬",
    title: "Messenger",
    subtitle: "Connect Telegram, Discord, Slack and more for notifications",
    expandedContent: "→ Configure in Settings → Messenger tab",
  },
];

export default function ExtrasStep({ onNext, onBack }: ExtrasStepProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
      <div style={{ textAlign: "center" }}>
        <h2
          style={{
            fontFamily: "'Press Start 2P', monospace",
            fontSize: 14,
            color: "var(--accent)",
            marginBottom: 10,
            lineHeight: 1.5,
          }}
        >
          Optional Integrations
        </h2>
        <p
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 12,
            color: "var(--text-secondary)",
            lineHeight: 1.6,
          }}
        >
          These are optional — you can skip them and configure later in Settings.
        </p>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {EXTRAS_CARDS.map((card) => {
          const isExpanded = expandedId === card.id;
          return (
            <div
              key={card.id}
              style={{
                background: "var(--bg-secondary)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                overflow: "hidden",
                transition: "border-color 0.15s",
              }}
            >
              <button
                onClick={() => setExpandedId(isExpanded ? null : card.id)}
                style={{
                  width: "100%",
                  padding: "14px 16px",
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: 14,
                  textAlign: "left",
                }}
              >
                <span style={{ fontSize: 24, flexShrink: 0 }}>{card.icon}</span>
                <div style={{ flex: 1 }}>
                  <div
                    style={{
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 13,
                      fontWeight: 600,
                      color: "var(--text-primary)",
                      marginBottom: 3,
                    }}
                  >
                    {card.title}
                  </div>
                  <div
                    style={{
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 11,
                      color: "var(--text-muted)",
                      lineHeight: 1.4,
                    }}
                  >
                    {card.subtitle}
                  </div>
                </div>
                <span
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 12,
                    color: "var(--text-muted)",
                    transition: "transform 0.15s",
                    transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)",
                    flexShrink: 0,
                  }}
                >
                  ▶
                </span>
              </button>

              {isExpanded && (
                <div
                  style={{
                    padding: "12px 16px 16px 54px",
                    borderTop: "1px solid var(--border)",
                    background: "color-mix(in srgb, var(--bg-base) 50%, transparent)",
                  }}
                >
                  <p
                    style={{
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 12,
                      color: "var(--accent)",
                      margin: 0,
                      lineHeight: 1.5,
                    }}
                  >
                    {card.expandedContent}
                  </p>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <button
          onClick={onBack}
          style={{
            padding: "10px 20px",
            background: "transparent",
            color: "var(--text-secondary)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 12,
            cursor: "pointer",
          }}
        >
          ← Back
        </button>
        <button
          onClick={onNext}
          style={{
            padding: "12px 32px",
            background: "var(--accent)",
            color: "#0d0d0f",
            border: "none",
            borderRadius: 6,
            fontFamily: "'Press Start 2P', monospace",
            fontSize: 11,
            cursor: "pointer",
            letterSpacing: "0.05em",
          }}
        >
          Next →
        </button>
      </div>
    </div>
  );
}
