import { useI18n, type I18nContextValue } from "../i18n";
import { type FormEvent, useState } from "react";
import { post } from "../api/core";

interface LoginPageProps {
  onSuccess: (csrfToken: string) => void;
}

interface LoginResponse {
  ok: boolean;
  csrf_token?: string;
}

function parseErrorMessage(err: unknown, t: I18nContextValue["t"]): string {
  const message = err instanceof Error ? err.message : String(err);
  switch (message) {
    case "invalid_password":
      return t({ en: "Invalid password", de: "Ungültiges Passwort" });
    case "too_many_attempts":
      return t({
        en: "Too many attempts. Try again in 15 minutes.",
        de: "Zu viele Versuche. Versuche es in 15 Minuten erneut.",
      });
    case "remote_access_not_configured":
      return t({
        en: "Remote access is not configured on this server.",
        de: "Der Fernzugriff ist auf diesem Server nicht eingerichtet.",
      });
    default:
      return message;
  }
}

export default function LoginPage({ onSuccess }: LoginPageProps) {
  const { t } = useI18n();
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (loading || !password) return;
    setLoading(true);
    setError(null);
    try {
      const result = await post<LoginResponse>("/api/auth/login", { password });
      if (result.ok && result.csrf_token) {
        onSuccess(result.csrf_token);
      } else {
        setError(
          t({ en: "Login failed. Please try again.", de: "Anmeldung fehlgeschlagen. Bitte versuche es erneut." }),
        );
      }
    } catch (err) {
      setError(parseErrorMessage(err, t));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center" style={{ background: "var(--th-bg-base, #0d0d0f)" }}>
      <div
        className="w-full max-w-sm rounded-xl border p-8"
        style={{
          background: "var(--th-card-bg, #18181b)",
          borderColor: "var(--th-card-border, #27272a)",
        }}
      >
        {/* Logo */}
        <div className="mb-6 flex flex-col items-center gap-4">
          <img src="/assets/ironcrew-logo-white.svg" alt="IronCrew" style={{ height: 64, width: "auto" }} />
          <h1
            className="text-lg"
            style={{ fontFamily: "'Press Start 2P', monospace", color: "var(--th-text-heading, #f4f4f5)" }}
          >
            IronCrew
          </h1>
          <p
            className="text-center text-xs"
            style={{ fontFamily: "'JetBrains Mono', monospace", color: "var(--th-text-muted, #71717a)" }}
          >
            {t({ en: "Enter password to access remotely", de: "Gib das Passwort für den Fernzugriff ein" })}
          </p>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} noValidate>
          <div className="mb-4">
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t({ en: "Password", de: "Passwort" })}
              aria-label={t({ en: "Password", de: "Passwort" })}
              autoComplete="current-password"
              autoFocus
              disabled={loading}
              className="w-full rounded-lg border px-4 py-3 text-sm outline-none transition-colors focus:ring-2"
              style={
                {
                  fontFamily: "'JetBrains Mono', monospace",
                  background: "var(--th-input-bg, #09090b)",
                  color: "var(--th-text-primary, #f4f4f5)",
                  borderColor: error ? "#ef4444" : "var(--th-card-border, #27272a)",
                  "--tw-ring-color": "var(--th-accent, #34D399)",
                } as React.CSSProperties
              }
            />
          </div>

          {error && (
            <p className="mb-4 text-xs" style={{ fontFamily: "'JetBrains Mono', monospace", color: "#ef4444" }}>
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={loading || !password}
            className="w-full rounded-lg px-4 py-3 transition-opacity disabled:opacity-50"
            style={{
              fontFamily: "'Press Start 2P', monospace",
              fontSize: "10px",
              background: "var(--th-accent, #34D399)",
              color: "#000000",
              cursor: loading || !password ? "not-allowed" : "pointer",
            }}
          >
            {loading ? "..." : t({ en: "Login", de: "Anmelden" })}
          </button>
        </form>
      </div>
    </div>
  );
}
