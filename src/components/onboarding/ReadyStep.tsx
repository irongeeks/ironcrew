import type { SetupStatus } from "../../api/messaging-runtime-oauth";

interface ReadyStepProps {
  setupStatus: SetupStatus | null;
  onFinish: () => void;
  onBack: () => void;
}

interface CheckDisplay {
  key: string;
  label: string;
  required: boolean;
}

const REQUIRED_CHECKS: CheckDisplay[] = [
  { key: "database", label: "Database", required: true },
  { key: "encryption_secret", label: "Encryption secret", required: true },
  { key: "webhook_secret", label: "Webhook secret", required: true },
  { key: "agents_seeded", label: "Agents seeded", required: true },
  { key: "departments_seeded", label: "Departments seeded", required: true },
  { key: "cli_provider_configured", label: "CLI provider", required: true },
];

const OPTIONAL_CHECKS: CheckDisplay[] = [
  { key: "api_key_configured", label: "API key", required: false },
  { key: "oauth_configured", label: "OAuth connected", required: false },
  { key: "agents_md_injected", label: "AGENTS.md injected", required: false },
  { key: "knowledge_vault_configured", label: "Knowledge vault connected", required: false },
];

export default function ReadyStep({ setupStatus, onFinish, onBack }: ReadyStepProps) {
  const allRequiredOk = setupStatus?.required_ok ?? false;

  const renderCheck = (check: CheckDisplay) => {
    const result = setupStatus?.checks[check.key];
    const isOk = result?.ok ?? false;
    const detail = result?.detail;

    return (
      <div
        key={check.key}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "8px 12px",
          background: "var(--bg-secondary)",
          borderRadius: 6,
          border: "1px solid var(--border)",
        }}
      >
        <span style={{ fontSize: 14, flexShrink: 0 }}>
          {setupStatus == null ? "⏳" : isOk ? "✅" : check.required ? "❌" : "⚠️"}
        </span>
        <div style={{ flex: 1 }}>
          <div
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 12,
              color: "var(--text-primary)",
            }}
          >
            {check.label}
          </div>
          {detail && (
            <div
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 10,
                color: "var(--text-muted)",
                marginTop: 2,
              }}
            >
              {detail}
            </div>
          )}
        </div>
        {!check.required && (
          <span
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 9,
              color: "var(--text-muted)",
              flexShrink: 0,
            }}
          >
            optional
          </span>
        )}
      </div>
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 40, marginBottom: 12 }}>{allRequiredOk ? "🚀" : "⚠️"}</div>
        <h2
          style={{
            fontFamily: "'Press Start 2P', monospace",
            fontSize: 14,
            color: allRequiredOk ? "var(--accent)" : "#f59e0b",
            marginBottom: 10,
            lineHeight: 1.5,
          }}
        >
          {setupStatus == null ? "Checking..." : allRequiredOk ? "You're All Set!" : "Almost Ready"}
        </h2>
        <p
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 12,
            color: "var(--text-secondary)",
            lineHeight: 1.6,
          }}
        >
          {allRequiredOk
            ? "All required checks passed. Your office is ready to launch."
            : "Some required checks failed. You may still proceed, but some features may not work."}
        </p>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div>
          <div
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 10,
              color: "var(--text-muted)",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              marginBottom: 8,
            }}
          >
            Required
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>{REQUIRED_CHECKS.map(renderCheck)}</div>
        </div>

        <div>
          <div
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 10,
              color: "var(--text-muted)",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              marginBottom: 8,
            }}
          >
            Optional
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>{OPTIONAL_CHECKS.map(renderCheck)}</div>
        </div>
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
          onClick={onFinish}
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
          Launch Office →
        </button>
      </div>
    </div>
  );
}
