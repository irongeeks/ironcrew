import { useState } from "react";

interface WelcomeStepProps {
  companyName: string;
  ceoName: string;
  onNext: (values: { companyName: string; ceoName: string }) => void;
}

export default function WelcomeStep({ companyName, ceoName, onNext }: WelcomeStepProps) {
  const [localCompanyName, setLocalCompanyName] = useState(companyName);
  const [localCeoName, setLocalCeoName] = useState(ceoName);

  const inputStyle: React.CSSProperties = {
    width: "100%",
    padding: "10px 12px",
    background: "var(--bg-base)",
    border: "1px solid var(--border)",
    borderRadius: 6,
    color: "var(--text-primary)",
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 13,
    outline: "none",
    boxSizing: "border-box",
  };

  const labelStyle: React.CSSProperties = {
    display: "block",
    marginBottom: 6,
    fontSize: 11,
    color: "var(--text-secondary)",
    fontFamily: "'JetBrains Mono', monospace",
    textTransform: "uppercase",
    letterSpacing: "0.05em",
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 32 }}>
      <div style={{ textAlign: "center" }}>
        <div
          style={{
            fontSize: 48,
            marginBottom: 16,
            filter: "drop-shadow(0 0 12px rgba(52, 211, 153, 0.4))",
          }}
        >
          🐙
        </div>
        <h1
          style={{
            fontFamily: "'Press Start 2P', monospace",
            fontSize: 18,
            color: "var(--accent)",
            marginBottom: 12,
            lineHeight: 1.4,
          }}
        >
          Welcome to IronCrew
        </h1>
        <p
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 13,
            color: "var(--text-secondary)",
            lineHeight: 1.6,
            maxWidth: 480,
            margin: "0 auto",
          }}
        >
          Let&apos;s get your AI agent office set up. This will only take a minute.
        </p>
      </div>

      <div
        style={{ display: "flex", flexDirection: "column", gap: 20, maxWidth: 440, margin: "0 auto", width: "100%" }}
      >
        <div>
          <label htmlFor="wizard-company-name" style={labelStyle}>
            Company Name
          </label>
          <input
            id="wizard-company-name"
            type="text"
            value={localCompanyName}
            onChange={(e) => setLocalCompanyName(e.target.value)}
            placeholder="e.g. IronCrew Corp"
            style={inputStyle}
            autoFocus
          />
        </div>

        <div>
          <label htmlFor="wizard-ceo-name" style={labelStyle}>
            Your Name (CEO)
          </label>
          <input
            id="wizard-ceo-name"
            type="text"
            value={localCeoName}
            onChange={(e) => setLocalCeoName(e.target.value)}
            placeholder="e.g. Alex"
            style={inputStyle}
          />
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "center" }}>
        <button
          onClick={() =>
            onNext({ companyName: localCompanyName.trim() || "IronCrew", ceoName: localCeoName.trim() || "CEO" })
          }
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
