import { I18nProvider } from "../i18n";

interface AppLoadingScreenProps {
  language: string;
  title: string;
  subtitle: string;
}

export default function AppLoadingScreen({ language, title, subtitle }: AppLoadingScreenProps) {
  return (
    <I18nProvider language={language}>
      <div className="h-screen flex items-center justify-center" style={{ background: "var(--th-bg-primary)" }}>
        <div className="text-center">
          <div
            className="font-pixel mb-6 animate-agent-bounce"
            style={{
              fontSize: 28,
              letterSpacing: "4px",
              color: "var(--accent, #8b5cf6)",
              textShadow: "4px 4px 0px rgba(0,0,0,0.4)",
            }}
          >
            OCTOOFFICE
          </div>
          <div className="text-sm font-medium" style={{ color: "var(--th-text-secondary)" }}>
            {title}
          </div>
          <div className="text-xs mt-1" style={{ color: "var(--th-text-muted)" }}>
            {subtitle}
          </div>
        </div>
      </div>
    </I18nProvider>
  );
}
