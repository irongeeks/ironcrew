import { Children, cloneElement, isValidElement, useEffect, useId, useState, type ReactNode } from "react";
import { request, string as str, type Row } from "./api.ts";
import styles from "./App.module.css";
export type Locale = "de" | "en";
export function Field({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  return (
    <div className={styles.field}>
      <label htmlFor={id}>{label}</label>
      {Children.map(children, (child) =>
        isValidElement<{ id?: string }>(child) &&
        typeof child.type === "string" &&
        ["input", "select", "textarea"].includes(child.type)
          ? cloneElement(child, { id })
          : child,
      )}
    </div>
  );
}
export const records = (value: unknown): Row[] => (Array.isArray(value) ? (value as Row[]) : []);
export function useRemote(path: string) {
  const [data, setData] = useState<Row>({}),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    const refresh = () => setRevision((value) => value + 1);
    window.addEventListener("ironcrew:update", refresh);
    return () => window.removeEventListener("ironcrew:update", refresh);
  }, []);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    void request(path)
      .then((value) => {
        if (alive) {
          setData(value);
          setError("");
        }
      })
      .catch((error) => alive && setError(error.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [path, revision]);
  return { data, error, loading, reload: () => setRevision((value) => value + 1) };
}
export function Feedback({ error, message }: { error?: string; message?: string }) {
  return (
    <>
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
    </>
  );
}
const knownCapabilities = [
  "workspace.list",
  "workspace.read",
  "workspace.apply_patch",
  "workspace.test_fixture",
  "workspace.execute",
];
export function Workers({ locale }: { locale: Locale }) {
  const t = (de: string, en: string) => (locale === "de" ? de : en);
  const status = useRemote("/workers/status"),
    workers = useRemote("/workers");
  const [pending, setPending] = useState<Row | null>(null),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [directory, setDirectory] = useState(""),
    [url, setUrl] = useState(""),
    [ca, setCa] = useState(""),
    [isolationProfile, setIsolationProfile] = useState(""),
    [execution, setExecution] = useState(false);
  const endpoint = url || str(status.data, "connectUrl"),
    tls = status.data.tlsConfigured === true;
  const settingsValid = /^wss:\/\//.test(endpoint) && !!directory.trim();
  const credential = async (path: string, body: Row, capabilities: string[], revision?: unknown) => {
    if (capabilities.includes("workspace.execute") && !isolationProfile.trim()) {
      setError(
        t(
          "Für Prozessausführung ist ein geprüftes Isolationsprofil auf dem Worker erforderlich.",
          "Process execution requires a verified isolation profile on the worker.",
        ),
      );
      return;
    }
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const value = await request(path, { method: "POST", body, revision });
      if (!str(value, "token"))
        throw new Error(
          t(
            "Die einmaligen Zugangsdaten wurden nicht zurückgegeben. Keine Wiederholung automatisch ausgelöst.",
            "One-time credentials were not returned. No automatic retry was issued.",
          ),
        );
      setPending({
        url: endpoint,
        workerId: value.workerId,
        token: value.token,
        generation: value.generation,
        capabilities,
        directory: `${directory.replace(/[\\/]$/, "")}/generation-${value.generation}`,
        ...(ca.trim() ? { caFile: ca.trim() } : {}),
        trustedFixtures: {},
        ...(capabilities.includes("workspace.execute") ? { isolationProfilePath: isolationProfile.trim() } : {}),
      });
      workers.reload();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  function download() {
    if (!pending) return;
    const blob = new Blob([JSON.stringify(pending, null, 2) + "\n"], { type: "application/json" }),
      href = URL.createObjectURL(blob),
      link = document.createElement("a");
    link.href = href;
    link.download = `ironcrew-worker-${str(pending, "workerId")}-g${pending.generation}.json`;
    link.click();
    setPending(null);
    setMessage(
      t(
        "Download gestartet. Die Zugangsdaten werden hier nicht erneut angezeigt.",
        "Download started. Credentials are not shown again here.",
      ),
    );
    window.setTimeout(() => URL.revokeObjectURL(href), 1000);
  }
  return (
    <section>
      <Feedback error={status.error || workers.error || error} message={message} />
      {!status.loading && !tls && (
        <p className={styles.warning} role="status">
          {t(
            "Worker-TLS ist nicht eingerichtet. Für Anmeldung, Rotation und Verbindung benötigt die Zentrale ihren konfigurierten TLS-Listener.",
            "Worker TLS is not configured. Enrollment, rotation and connection require the Control TLS listener.",
          )}
        </p>
      )}
      {pending && (
        <section
          className={styles.panel}
          aria-label={t("Einmalige Worker-Zugangsdaten", "One-time worker credentials")}
        >
          <h3>{t("Zugang jetzt herunterladen", "Download credentials now")}</h3>
          <p>
            {t(
              "Das Zugangstoken ist nur in dieser Antwort verfügbar. Die Datei enthält das Geheimnis und gehört geschützt auf den vorgesehenen Worker.",
              "The access token is available only in this response. The file contains the secret and must be stored securely on the intended worker.",
            )}
          </p>
          <p>
            {t("Worker", "Worker")}: {str(pending, "workerId")} · {t("Generation", "Generation")}{" "}
            {String(pending.generation)}
          </p>
          <button onClick={download}>
            {t("Worker-Konfiguration einmalig herunterladen", "Download one-time worker configuration")}
          </button>
        </section>
      )}
      <form
        className={styles.settingsForm}
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          const capabilities = data.getAll("capability").map(String);
          if (!capabilities.length) {
            setError(t("Mindestens eine Fähigkeit auswählen.", "Choose at least one capability."));
            return;
          }
          void credential(
            "/workers/enroll",
            { name: data.get("name"), capabilities, maxConcurrent: Number(data.get("maxConcurrent")) },
            capabilities,
          );
        }}
      >
        <h3>{t("Worker anmelden", "Enroll worker")}</h3>
        <Field label={t("Workername", "Worker name")}>
          <input name="name" required maxLength={200} />
        </Field>
        <Field label={t("Verschlüsselte Worker-Verbindung (wss://)", "Encrypted worker connection (wss://)")}>
          <input
            type="url"
            value={endpoint}
            onChange={(event) => setUrl(event.target.value)}
            pattern="wss://.*"
            required
          />
        </Field>
        <Field label={t("Basis-Datenverzeichnis auf dem Worker", "Base data directory on worker")}>
          <input
            value={directory}
            onChange={(event) => setDirectory(event.target.value)}
            placeholder="/srv/ironcrew-worker"
            required
          />
        </Field>
        <Field label={t("CA-Zertifikatdatei auf dem Worker (optional)", "CA certificate file on worker (optional)")}>
          <input value={ca} onChange={(event) => setCa(event.target.value)} />
        </Field>
        <p className={styles.muted}>
          {t(
            "Jede neue Zugangsgeneration bekommt ein eigenes Unterverzeichnis, damit alte Wiederholungszähler nicht übernommen werden.",
            "Each credential generation receives its own subdirectory so previous replay counters are not reused.",
          )}
        </p>
        <fieldset>
          <legend>{t("Erlaubte Fähigkeiten", "Allowed capabilities")}</legend>
          {knownCapabilities.map((capability) => (
            <label className={styles.check} key={capability}>
              <input
                type="checkbox"
                name="capability"
                value={capability}
                onChange={(event) => capability === "workspace.execute" && setExecution(event.target.checked)}
              />
              {capability}
            </label>
          ))}
        </fieldset>
        <Field
          label={t(
            "Isolationsprofil-Datei auf dem Worker (für Prozessausführung erforderlich)",
            "Isolation profile file on worker (required for process execution)",
          )}
        >
          <input
            value={isolationProfile}
            onChange={(event) => setIsolationProfile(event.target.value)}
            required={execution}
          />
        </Field>
        <Field label={t("Gleichzeitige Aktionen", "Concurrent actions")}>
          <input type="number" name="maxConcurrent" min={1} max={16} defaultValue={1} required />
        </Field>
        <button disabled={!tls || !settingsValid || busy || !!pending}>
          {t("Anmelden und Zugang erzeugen", "Enroll and issue credentials")}
        </button>
      </form>
      <div className={styles.resourceList}>
        {records(workers.data.items).map((worker) => (
          <article className={styles.resource} key={str(worker, "id")}>
            <h3>{str(worker, "name")}</h3>
            <p>
              {worker.revoked === true
                ? t("Zugang widerrufen", "Access revoked")
                : t("Zugang registriert", "Credentials registered")}{" "}
              · {t("Generation", "Generation")} {String(worker.generation ?? "—")}
            </p>
            <p>
              {t("Letzter Kontakt", "Last contact")}:{" "}
              {str(worker, "lastSeenAt")
                ? new Date(str(worker, "lastSeenAt")).toLocaleString(locale)
                : t("noch kein Kontakt bestätigt", "no connection confirmed yet")}
            </p>
            <p>{Array.isArray(worker.capabilities) ? worker.capabilities.join(", ") : "—"}</p>
            <button
              className={styles.secondary}
              disabled={!tls || !settingsValid || busy || !!pending}
              onClick={() =>
                void credential(
                  `/workers/${str(worker, "id")}/rotate`,
                  {},
                  Array.isArray(worker.capabilities) ? worker.capabilities.map(String) : [],
                  worker.revision,
                )
              }
            >
              {t("Zugang rotieren", "Rotate credentials")}
            </button>
            {worker.revoked !== true && (
              <details>
                <summary>{t("Workerzugang widerrufen", "Revoke worker access")}</summary>
                <p>
                  {t(
                    "Die Verbindung wird getrennt. Offene Wirkungen müssen separat abgeglichen werden.",
                    "The connection closes. Pending effects must be reconciled separately.",
                  )}
                </p>
                <button
                  className={styles.secondary}
                  disabled={!tls || busy}
                  onClick={async () => {
                    setBusy(true);
                    setError("");
                    try {
                      await request(`/workers/${str(worker, "id")}/revoke`, {
                        method: "POST",
                        body: {},
                        revision: worker.revision,
                      });
                      workers.reload();
                      setMessage(t("Workerzugang widerrufen.", "Worker access revoked."));
                    } catch (error) {
                      setError(error instanceof Error ? error.message : String(error));
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {t("Zugang jetzt widerrufen", "Revoke access now")}
                </button>
              </details>
            )}
          </article>
        ))}
      </div>
      {!workers.loading && !records(workers.data.items).length && (
        <p>{t("Noch keine Worker angemeldet.", "No workers enrolled yet.")}</p>
      )}
    </section>
  );
}
