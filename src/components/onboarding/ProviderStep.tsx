import { useState } from "react";
import type { CliProvider, CliStatusMap } from "../../types";
import CliAuthModal from "../cli-auth/CliAuthModal";

interface ProviderStepProps {
  defaultProvider: CliProvider;
  cliStatus: CliStatusMap | null;
  onNext: (provider: CliProvider) => void;
  onBack: () => void;
  onAuthSuccess?: () => void;
}

const PROVIDER_INFO: Array<{ key: CliProvider; label: string; icon: string; description: string }> = [
  { key: "claude", label: "Claude Code", icon: "🟣", description: "Anthropic Claude — best reasoning" },
  { key: "codex", label: "Codex CLI", icon: "🟢", description: "OpenAI Codex — fast & capable" },
  { key: "gemini", label: "Gemini CLI", icon: "🔵", description: "Google Gemini — multimodal" },
  { key: "openclaw", label: "OpenClaw", icon: "🦀", description: "OpenClaw — isolated profiles" },
  { key: "opencode", label: "OpenCode", icon: "⚪", description: "OpenCode — flexible routing" },
  { key: "copilot", label: "GitHub Copilot", icon: "🚀", description: "GitHub Copilot — code-focused" },
  { key: "antigravity", label: "Antigravity", icon: "🌌", description: "Antigravity — Google OAuth" },
];

export default function ProviderStep({ defaultProvider, cliStatus, onNext, onBack, onAuthSuccess }: ProviderStepProps) {
  const [selected, setSelected] = useState<CliProvider>(defaultProvider);
  const [authModalProvider, setAuthModalProvider] = useState<"claude" | "codex" | "gemini" | null>(null);
  const cliAuthProviders = ["claude", "codex", "gemini"];

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
          Choose Your AI Provider
        </h2>
        <p
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 12,
            color: "var(--text-secondary)",
            lineHeight: 1.6,
          }}
        >
          Select the default CLI provider for your agents. You can change this later in Settings.
        </p>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
          gap: 10,
        }}
      >
        {PROVIDER_INFO.map(({ key, label, icon, description }) => {
          const status = cliStatus?.[key];
          const isInstalled = status?.installed ?? false;
          const isAuthenticated = status?.authenticated ?? false;
          const isReady = isInstalled && isAuthenticated;
          const isSelected = selected === key;

          return (
            <div key={key} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <button
                onClick={() => setSelected(key)}
                style={{
                  padding: "14px 12px",
                  background: isSelected
                    ? "color-mix(in srgb, var(--accent) 15%, var(--bg-secondary))"
                    : "var(--bg-secondary)",
                  border: isSelected ? "2px solid var(--accent)" : "2px solid var(--border)",
                  borderRadius: 8,
                  cursor: "pointer",
                  textAlign: "left",
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                  transition: "border-color 0.15s, background 0.15s",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span style={{ fontSize: 22 }}>{icon}</span>
                  <span
                    style={{
                      fontSize: 9,
                      fontFamily: "'JetBrains Mono', monospace",
                      padding: "2px 6px",
                      borderRadius: 4,
                      background: isReady
                        ? "color-mix(in srgb, var(--accent) 20%, transparent)"
                        : isInstalled
                          ? "color-mix(in srgb, #f59e0b 20%, transparent)"
                          : "color-mix(in srgb, var(--text-muted) 15%, transparent)",
                      color: isReady ? "var(--accent)" : isInstalled ? "#f59e0b" : "var(--text-muted)",
                    }}
                  >
                    {cliStatus == null ? "..." : isReady ? "ready" : isInstalled ? "auth needed" : "not installed"}
                  </span>
                </div>
                <div
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 12,
                    fontWeight: 600,
                    color: isSelected ? "var(--accent)" : "var(--text-primary)",
                  }}
                >
                  {label}
                </div>
                <div
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 10,
                    color: "var(--text-muted)",
                    lineHeight: 1.4,
                  }}
                >
                  {description}
                </div>
              </button>
              {cliAuthProviders.includes(key) && isInstalled && !isAuthenticated && (
                <button
                  onClick={() => setAuthModalProvider(key as "claude" | "codex" | "gemini")}
                  style={{
                    padding: "6px 12px",
                    background: "color-mix(in srgb, var(--accent) 15%, var(--bg-secondary))",
                    border: "1px solid var(--accent)",
                    borderRadius: 6,
                    cursor: "pointer",
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 10,
                    color: "var(--accent)",
                  }}
                >
                  Authenticate
                </button>
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
          onClick={() => onNext(selected)}
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
      {authModalProvider && (
        <CliAuthModal
          provider={authModalProvider}
          open={!!authModalProvider}
          onClose={() => setAuthModalProvider(null)}
          onSuccess={() => {
            setAuthModalProvider(null);
            onAuthSuccess?.();
          }}
        />
      )}
    </div>
  );
}
