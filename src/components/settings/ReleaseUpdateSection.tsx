import { useEffect, useState } from "react";
import { getUpdateStatus, type UpdateStatus } from "../../api/messaging-runtime-oauth";

const installLabel = { docker: "Docker Compose", native: "Nativer Dienst", source: "Quellcode-Checkout" };
export function ReleaseUpdateSection(): React.JSX.Element {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void getUpdateStatus()
      .then((value) => {
        if (active) setStatus(value);
      })
      .catch(() => {
        if (active) setError("Versionsinformationen konnten nicht geladen werden.");
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, []);
  const refresh = async () => {
    setBusy(true);
    setError("");
    try {
      setStatus(await getUpdateStatus(true));
    } catch {
      setError("Release-Prüfung nicht erreichbar. Bitte erneut versuchen.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      aria-label="Version und Updates"
      className="space-y-3 rounded-xl border p-4"
      style={{ borderColor: "var(--th-card-border)", background: "var(--th-bg-surface)" }}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">IronCrew · Version und Updates</h3>
        <button type="button" className="ic-btn" disabled={busy} onClick={() => void refresh()}>
          Stable Release prüfen
        </button>
      </div>
      {busy && <p role="status">Versionsinformationen werden geladen …</p>}
      {error && <p role="alert">{error}</p>}
      {status && (
        <>
          <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
            <div>
              <dt>Installiert</dt>
              <dd>v{status.current_version}</dd>
            </div>
            <div>
              <dt>Installation</dt>
              <dd>{status.install_type ? installLabel[status.install_type] : "Nicht ermittelt"}</dd>
            </div>
            <div>
              <dt>Aktuelles Stable Release</dt>
              <dd>{status.latest_version ? `v${status.latest_version}` : "Noch nicht ermittelt"}</dd>
            </div>
            <div>
              <dt>Letzte Prüfung</dt>
              <dd>{new Date(status.checked_at).toLocaleString("de-DE")}</dd>
            </div>
          </dl>
          <p role="status" className="text-sm">
            {!status.enabled
              ? "Release-Prüfung ist auf diesem Server deaktiviert."
              : status.error
                ? "Release-Prüfung fehlgeschlagen; der aktuelle Release-Stand ist unbekannt."
                : status.discovery === "no_release"
                  ? "Noch kein veröffentlichtes Stable Release vorhanden."
                  : status.update_available
                    ? "Ein neueres Stable Release ist verfügbar."
                    : status.latest_version
                      ? "Kein neueres Stable Release verfügbar."
                      : "Release-Stand noch nicht bekannt."}
          </p>
          {status.release_url && (
            <a className="text-sm underline" href={status.release_url} target="_blank" rel="noopener noreferrer">
              Release-Hinweise öffnen
            </a>
          )}
          <p className="text-sm">
            Updates werden auf dem Host vorbereitet. Die Weboberfläche verändert weder die Installation noch laufende
            Dienste.
          </p>
          {status.instructions && (
            <>
              {status.instructions.command && (
                <div>
                  <p className="text-sm font-semibold">Vorprüfung im IronCrew-Verzeichnis auf dem Host</p>
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
                Vollständige Update- und Wiederherstellungsanleitung
              </a>
            </>
          )}
        </>
      )}
    </section>
  );
}
