import { useI18n } from "../../i18n";
import LocalizedText, { useUiCopy } from "../LocalizedText";
import { useEffect, useState } from "react";
import { getUpdateStatus, type UpdateStatus } from "../../api/messaging-runtime-oauth";

export function ReleaseUpdateSection(): React.JSX.Element {
  const translateUiCopy = useUiCopy();
  const { locale, language } = useI18n();
  const installLabel = {
    docker: "Docker Compose",
    native: translateUiCopy("Native service", "Nativer Dienst"),
    source: translateUiCopy("Source checkout", "Quellcode-Checkout"),
  };
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void getUpdateStatus(false, language)
      .then((value) => {
        if (active) setStatus(value);
      })
      .catch(() => {
        if (active)
          setError(
            translateUiCopy(
              "Version information could not be loaded.",
              "Versionsinformationen konnten nicht geladen werden.",
            ),
          );
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [translateUiCopy, language]);
  const refresh = async () => {
    setBusy(true);
    setError("");
    try {
      setStatus(await getUpdateStatus(true, language));
    } catch {
      setError(
        translateUiCopy(
          "Release check unavailable. Please try again.",
          "Release-Prüfung nicht erreichbar. Bitte erneut versuchen.",
        ),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      aria-label={translateUiCopy("Version and updates", "Version und Updates")}
      className="space-y-3 rounded-xl border p-4"
      style={{ borderColor: "var(--th-card-border)", background: "var(--th-bg-surface)" }}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">
          <LocalizedText en="IronCrew · Version and updates" de="IronCrew · Version und Updates" />
        </h3>
        <button type="button" className="ic-btn" disabled={busy} onClick={() => void refresh()}>
          <LocalizedText en="Check stable release" de="Stable Release prüfen" />
        </button>
      </div>
      {busy && (
        <p role="status">
          <LocalizedText en="Loading version information …" de="Versionsinformationen werden geladen …" />
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {status && (
        <>
          <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
            <div>
              <dt>
                <LocalizedText en="Installed" de="Installiert" />
              </dt>
              <dd>v{status.current_version}</dd>
            </div>
            <div>
              <dt>Installation</dt>
              <dd>
                {status.install_type
                  ? installLabel[status.install_type]
                  : translateUiCopy("Unknown", "Nicht ermittelt")}
              </dd>
            </div>
            <div>
              <dt>
                <LocalizedText en="Latest stable release" de="Aktuelles Stable Release" />
              </dt>
              <dd>
                {status.latest_version
                  ? `v${status.latest_version}`
                  : translateUiCopy("Not checked yet", "Noch nicht ermittelt")}
              </dd>
            </div>
            <div>
              <dt>
                <LocalizedText en="Last checked" de="Letzte Prüfung" />
              </dt>
              <dd>{new Date(status.checked_at).toLocaleString(locale)}</dd>
            </div>
          </dl>
          <p role="status" className="text-sm">
            {!status.enabled
              ? translateUiCopy(
                  "Release checks are disabled on this server.",
                  "Release-Prüfung ist auf diesem Server deaktiviert.",
                )
              : status.error
                ? translateUiCopy(
                    "Release check failed; the current release status is unknown.",
                    "Release-Prüfung fehlgeschlagen; der aktuelle Release-Stand ist unbekannt.",
                  )
                : status.discovery === "no_release"
                  ? translateUiCopy(
                      "No stable release has been published yet.",
                      "Noch kein veröffentlichtes Stable Release vorhanden.",
                    )
                  : status.update_available
                    ? translateUiCopy(
                        "A newer stable release is available.",
                        "Ein neueres Stable Release ist verfügbar.",
                      )
                    : status.latest_version
                      ? translateUiCopy("No newer stable release available.", "Kein neueres Stable Release verfügbar.")
                      : translateUiCopy("Release status is not known yet.", "Release-Stand noch nicht bekannt.")}
          </p>
          {status.release_url && (
            <a className="text-sm underline" href={status.release_url} target="_blank" rel="noopener noreferrer">
              <LocalizedText en="Open release notes" de="Release-Hinweise öffnen" />
            </a>
          )}
          <p className="text-sm">
            <LocalizedText
              en="Updates are prepared on the host. The web interface does not change the installation or running services."
              de="Updates werden auf dem Host vorbereitet. Die Weboberfläche verändert weder die Installation noch laufende Dienste."
            />
          </p>
          {status.instructions && (
            <>
              {status.instructions.command && (
                <div>
                  <p className="text-sm font-semibold">
                    <LocalizedText
                      en="Preflight check in the IronCrew directory on the host"
                      de="Vorprüfung im IronCrew-Verzeichnis auf dem Host"
                    />
                  </p>
                  <pre
                    className="mt-2 overflow-x-auto rounded-lg p-3 text-xs"
                    style={{ background: "var(--th-input-bg)" }}
                  >
                    <code>{status.instructions.command}</code>
                  </pre>
                </div>
              )}
              <ol className="list-decimal space-y-1 pl-5 text-sm">
                {status.instructions.steps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
              <a
                className="inline-block text-sm underline"
                href={status.instructions.documentation_url}
                target="_blank"
                rel="noopener noreferrer"
              >
                <LocalizedText
                  en="Full update and recovery guide"
                  de="Vollständige Update- und Wiederherstellungsanleitung"
                />
              </a>
            </>
          )}
        </>
      )}
    </section>
  );
}
