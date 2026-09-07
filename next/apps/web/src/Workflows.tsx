import { useId, Children, isValidElement, cloneElement } from "react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { list, request, string as str, type Row } from "./api.ts";
import styles from "./App.module.css";
import Hosting from "./Hosting.tsx";
import WebsiteCare from "./WebsiteCare.tsx";
import IncidentOperations from "./IncidentOperations.tsx";
import { ModelRatingSummary, OrderModelRating } from "./ModelRatings.tsx";
import ResearchWatches from "./ResearchWatches.tsx";
import DocumentPreview from "./DocumentPreview.tsx";
import Coordination from "./Coordination.tsx";
import { ConceptPreview, SitePreview } from "./SitePreview.tsx";
import OAuthProfiles from "./OAuthProfiles.tsx";
import { useRemote, records } from "./Operations.tsx";
type Locale = "de" | "en";
const useText = (locale: Locale) => (de: string, en: string) => (locale === "de" ? de : en);
function workflowStateLabel(state: string, locale: Locale) {
  const labels: Record<string, [string, string]> = {
    not_started: ["Noch nicht begonnen", "Not started"],
    briefing: ["Briefing", "Briefing"],
    concepts: ["Konzepte zur Auswahl", "Concept selection"],
    selected: ["Richtung gewählt", "Direction selected"],
    built: ["Umsetzung bereit", "Build ready"],
    reviewed: ["Geprüft", "Reviewed"],
    accepted: ["Abgenommen", "Accepted"],
    published: ["Veröffentlicht", "Published"],
    investigating: ["Diagnose läuft", "Investigating"],
    repairing: ["Reparatur läuft", "Repairing"],
    observing: ["In Beobachtung", "Under observation"],
    resolved: ["Behoben und geprüft", "Resolved and verified"],
    blocked: ["Blockiert", "Blocked"],
    pending: ["Ausstehend", "Pending"],
    approval: ["Freigabe erforderlich", "Approval required"],
    delivered: ["Abgelegt", "Delivered"],
    conflict: ["Konflikt klären", "Resolve conflict"],
    failed: ["Fehlgeschlagen", "Failed"],
    effect_unknown: ["Wirkung ungeklärt", "Effect unknown"],
    received: ["Erfasst", "Received"],
    prepared: ["Vorbereitet", "Prepared"],
    completed: ["Abgeschlossen", "Completed"],
    running: ["In Bearbeitung", "Running"],
  };
  return (
    labels[state]?.[locale === "de" ? 0 : 1] ??
    (state === "—" ? "—" : locale === "de" ? "Stand wird geklärt" : "Status being reconciled")
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  const inputId = useId();
  return (
    <div className={styles.field}>
      <label htmlFor={inputId}>{label}</label>
      {Children.map(children, (child) =>
        isValidElement<{ id?: string }>(child) &&
        typeof child.type === "string" &&
        ["input", "select", "textarea"].includes(child.type)
          ? cloneElement(child, { id: inputId })
          : child,
      )}
    </div>
  );
}

function useMutation(onChange?: () => void) {
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [success, setSuccess] = useState("");
  async function save(path: string, body: unknown, revision?: unknown, method = "POST") {
    setError("");
    setSuccess("");
    setBusy(true);
    try {
      const result = await request(path, { method, body, revision });
      setSuccess(typeof result.state === "string" ? result.state : "saved");
      onChange?.();
      return result;
    } catch (error) {
      setError((error as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  }
  return { save, error, busy, success };
}
function Feedback({ state, locale }: { state: ReturnType<typeof useMutation>; locale: Locale }) {
  const t = useText(locale);
  return (
    <>
      {state.error && (
        <p className={styles.error} role="alert">
          {state.error}
        </p>
      )}
      {state.success && (
        <p role="status" className={styles.muted}>
          {state.success === "approval"
            ? t(
                "Wartet auf deine konkrete Freigabe unter Entscheidungen. Danach dieselbe Ablage fortsetzen.",
                "Waiting for your concrete approval in Decisions. Then resume this same delivery.",
              )
            : state.success === "conflict"
              ? t(
                  "Ablagekonflikt. Es wurde nichts überschrieben. Erwartete Version prüfen.",
                  "Delivery conflict. Nothing was overwritten. Check the expected revision.",
                )
              : state.success === "effect_unknown"
                ? t(
                    "Externe Wirkung ungeklärt. Vor einem weiteren Versuch muss der Zielstand abgeglichen werden.",
                    "External effect is unknown. Reconcile the destination before another attempt.",
                  )
                : state.success === "delivered"
                  ? t("Externe Ablage bestätigt.", "External delivery confirmed.")
                  : t(
                      "Gespeichert. Der tatsächliche Arbeitsstand ist oben sichtbar.",
                      "Saved. The actual work state is shown above.",
                    )}
        </p>
      )}
    </>
  );
}
export function ConfigurationPanel({ company, locale, section }: { company: Row; locale: Locale; section: string }) {
  const t = useText(locale),
    [configuration, setConfiguration] = useState<Row | null>(null),
    [models, setModels] = useState<Row[]>([]),
    [areas, setAreas] = useState<Row[]>([]),
    [provider, setProvider] = useState("research"),
    [refresh, setRefresh] = useState(0),
    [loadError, setLoadError] = useState("");
  const mutation = useMutation(() => setRefresh((v) => v + 1));
  useEffect(() => {
    void Promise.all([request("/configuration"), list("/models"), list("/areas")])
      .then(([c, m, a]) => {
        setConfiguration(c);
        setModels(m);
        setAreas(a);
        setLoadError("");
      })
      .catch((error) => setLoadError(error.message));
  }, [refresh]);
  if (loadError)
    return (
      <div className={styles.error} role="alert">
        {loadError}
        <button onClick={() => setRefresh((v) => v + 1)}>{t("Erneut laden", "Retry")}</button>
      </div>
    );
  if (!configuration) return <div className={styles.skeleton} />;
  const proton = (configuration.proton ?? {}) as Row,
    router = (configuration.openrouter ?? {}) as Row,
    secret = (router.secretRef ?? {}) as Row,
    connections = (configuration.connections ?? []) as Row[];
  const capabilities: Record<string, string[]> = {
    research: ["research.fetch"],
    brave: ["research.search"],
    nextcloud: ["nextcloud.read", "nextcloud.list", "nextcloud.write"],
    gdrive: ["gdrive.read", "gdrive.create"],
    sevdesk: [
      "sevdesk.invoices.read",
      "sevdesk.vouchers.read",
      "sevdesk.transactions.read",
      "sevdesk.invoice.read",
      "sevdesk.voucher.upload",
      "sevdesk.reminder.create",
      "sevdesk.reminder.send",
    ],
    tactical: ["tactical.agents.read", "tactical.alerts.read", "tactical.script.run"],
    proxmox: ["proxmox.nodes.read", "proxmox.guests.read", "proxmox.guest.action", "proxmox.task.read"],
    graph: ["graph.users.read", "graph.licenses.read", "graph.health.read", "graph.user.licenses", "graph.mail.send"],
    telegram: ["telegram.send"],
    discord: ["discord.send"],
  };
  async function modelSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const f = new FormData(event.currentTarget),
      shareId = String(f.get("shareId")),
      itemId = String(f.get("itemId"));
    const executable = String(f.get("executable")),
      sessionDirectory = String(f.get("sessionDirectory"));
    await mutation.save(
      "/configuration",
      {
        ...configuration,
        version: 1,
        liveExecutionEnabled: f.get("enabled") === "on",
        isolationProfilePath: String(f.get("isolationProfilePath") ?? "").trim() || undefined,
        remoteWorkerId: String(f.get("remoteWorkerId") ?? "").trim() || undefined,
        proton: executable ? { executable, ...(sessionDirectory ? { sessionDirectory } : {}) } : undefined,
        openrouter:
          shareId && itemId
            ? {
                secretRef: { provider: "proton-pass", shareId, itemId, field: String(f.get("field")) },
                ...(f.get("modelOverride") ? { modelOverride: f.get("modelOverride") } : {}),
              }
            : undefined,
      },
      undefined,
      "PUT",
    );
  }
  async function connectionSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const f = new FormData(event.currentTarget),
      shareId = String(f.get("shareId") ?? ""),
      itemId = String(f.get("itemId") ?? "");
    const optional = (name: string) => (f.get(name) ? { [name]: String(f.get(name)) } : {});
    const connection = {
      id: crypto.randomUUID(),
      provider,
      scope: { companyId: company.id, areaId: f.get("areaId") },
      ...optional("baseUrl"),
      ...optional("username"),
      ...optional("tokenId"),
      ...optional("rootPath"),
      ...(shareId && itemId
        ? { secretRef: { provider: "proton-pass", shareId, itemId, field: String(f.get("field")) } }
        : {}),
      resourceIds: String(f.get("resourceIds")).split("\n").filter(Boolean),
      enabledTools: f.getAll("tool"),
      schemaTag: "ironcrew-config-v1",
    };
    await mutation.save(
      "/configuration",
      { ...configuration, connections: [...connections, connection] },
      undefined,
      "PUT",
    );
  }
  return (
    <>
      {section === "models" ? (
        <>
          <form className={styles.settingsForm} onSubmit={(e) => void modelSave(e)}>
            <p>
              {t(
                "Proton Pass liefert den Zugang erst bei einem autorisierten Aufruf. Hier werden nur Verweise gespeichert.",
                "Proton Pass supplies credentials only for authorized calls. This form stores references only.",
              )}
            </p>
            <Field
              label={t(
                "Installiertes pass-cli Programm (absoluter Pfad)",
                "Installed pass-cli executable (absolute path)",
              )}
            >
              <input name="executable" defaultValue={str(proton, "executable")} placeholder="/usr/local/bin/pass-cli" />
            </Field>
            <Field label={t("Geschütztes Sitzungsverzeichnis (optional)", "Protected session directory (optional)")}>
              <input name="sessionDirectory" defaultValue={str(proton, "sessionDirectory")} />
            </Field>
            <Field
              label={t(
                "Geprüftes Isolationsprofil (absoluter Serverpfad, optional)",
                "Verified isolation profile (absolute server path, optional)",
              )}
            >
              <input
                name="isolationProfilePath"
                pattern="/.*"
                defaultValue={str(configuration, "isolationProfilePath")}
              />
            </Field>
            <p className={styles.muted}>
              {t(
                "Das Profil wird beim Start tatsächlich attestiert. Ohne gültige Isolation bleibt Befehlsausführung gesperrt.",
                "The profile is attested at startup. Command execution remains blocked without valid isolation.",
              )}
            </p>
            <Field
              label={t("Entfernter Build-Worker (Geräte-ID, optional)", "Remote build worker (device ID, optional)")}
            >
              <input name="remoteWorkerId" defaultValue={str(configuration, "remoteWorkerId")} />
            </Field>
            <p className={styles.muted}>
              {t(
                "Wähle entweder ein lokales Isolationsprofil oder die ID eines unter Worker eingerichteten Geräts. Entfernte Builds benötigen TLS und eine gültige Isolation auf dem Worker.",
                "Choose either a local isolation profile or the ID of a device enrolled under Workers. Remote builds require TLS and valid isolation on that worker.",
              )}
            </p>
            <SecretFields secret={secret} />
            <Field label={t("Festes OpenRouter-Modell (optional)", "Fixed OpenRouter model (optional)")}>
              <input name="modelOverride" list="models" defaultValue={str(router, "modelOverride")} />
              <datalist id="models">
                {models.map((model) => (
                  <option key={str(model, "id")} value={str(model, "id")}>
                    {str(model, "name")}
                  </option>
                ))}
              </datalist>
            </Field>
            <label className={styles.check}>
              <input name="enabled" type="checkbox" defaultChecked={configuration.liveExecutionEnabled === true} />
              {t("Live-Ausführung ausdrücklich aktivieren", "Explicitly enable live execution")}
            </label>
            <p className={styles.warning}>
              {t(
                "Modellaufrufe können Kosten verursachen. Das gemeinsame Budget und die Mandatsgrenzen gelten weiterhin.",
                "Model calls may incur charges. Company budget and mandate limits still apply.",
              )}
            </p>
            <Feedback state={mutation} locale={locale} />
            <div className={styles.actions}>
              <button disabled={mutation.busy}>{t("Modellzugang speichern", "Save model access")}</button>
              <button
                type="button"
                className={styles.secondary}
                disabled={mutation.busy}
                onClick={() => void mutation.save("/models/refresh", {})}
              >
                {t("Verbindung & Katalog prüfen", "Test connection & catalog")}
              </button>
            </div>
          </form>
          <div className={styles.sectionHeading}>
            <h2>{t("Verfügbarer Modellkatalog", "Available model catalog")}</h2>
            <span>{models.length}</span>
          </div>
          <ul>
            {models.map((model) => (
              <li key={str(model, "id")}>
                <strong>{str(model, "name", str(model, "id"))}</strong>{" "}
                <span className={styles.muted}>{str(model, "id")}</span>
              </li>
            ))}
          </ul>
          <ModelRatingSummary locale={locale} />
        </>
      ) : (
        <>
          <OAuthProfiles locale={locale} onChange={() => setRefresh((value) => value + 1)} />
          <div className={styles.resourceList}>
            {connections.map((connection) => (
              <article className={styles.resource} key={str(connection, "id")}>
                <h3>{str(connection, "provider")}</h3>
                <p className={styles.muted}>{str(connection, "baseUrl", str(connection, "id"))}</p>
                <p>{Array.isArray(connection.enabledTools) ? connection.enabledTools.join(", ") : ""}</p>
                <p>
                  {connection.liveValidatedAt
                    ? t("Live geprüft", "Live verified")
                    : t("Noch kein erfolgreicher Live-Test dokumentiert", "No successful live test documented")}
                </p>
              </article>
            ))}
          </div>
          <details className={styles.panel}>
            <summary>{t("Neue Verbindung einrichten", "Configure new connection")}</summary>
            <form onSubmit={(e) => void connectionSave(e)}>
              <Field label={t("Dienst", "Service")}>
                <select value={provider} onChange={(e) => setProvider(e.target.value)}>
                  {Object.keys(capabilities).map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t("Bereich", "Area")}>
                <select name="areaId" required>
                  {areas.map((a) => (
                    <option key={str(a, "id")} value={str(a, "id")}>
                      {str(a, "name")}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t("Dienstadresse (falls erforderlich)", "Service base URL (if required)")}>
                <input name="baseUrl" type="url" placeholder="https://" />
              </Field>
              {provider !== "research" && <SecretFields secret={{}} />}
              <Field label={t("Benutzername (optional)", "Username (optional)")}>
                <input name="username" />
              </Field>
              <Field label={t("Token-ID (optional)", "Token ID (optional)")}>
                <input name="tokenId" />
              </Field>
              <Field label={t("Ablagewurzel (optional)", "Storage root (optional)")}>
                <input name="rootPath" />
              </Field>
              <Field
                label={t("Erlaubte Zielressourcen (eine ID je Zeile)", "Allowed target resources (one ID per line)")}
              >
                <textarea name="resourceIds" rows={3} />
              </Field>
              <fieldset>
                <legend>{t("Erlaubte Aktionen", "Allowed actions")}</legend>
                {capabilities[provider].map((tool) => (
                  <label key={tool} className={styles.check}>
                    <input type="checkbox" name="tool" value={tool} />
                    {tool}
                  </label>
                ))}
              </fieldset>
              <p className={styles.muted}>
                {t(
                  "Diese Verbindung ersetzt kein Mandat und keine konkrete Freigabe.",
                  "This connection does not replace a mandate or concrete approval.",
                )}
              </p>
              <Feedback state={mutation} locale={locale} />
              <button disabled={mutation.busy}>{t("Verbindung speichern", "Save connection")}</button>
            </form>
          </details>
        </>
      )}
    </>
  );
}
function SecretFields({ secret }: { secret: Row }) {
  return (
    <>
      <Field label="Proton Pass · Share ID">
        <input name="shareId" defaultValue={str(secret, "shareId")} />
      </Field>
      <Field label="Proton Pass · Item ID">
        <input name="itemId" defaultValue={str(secret, "itemId")} />
      </Field>
      <Field label="Proton Pass · Field">
        <input name="field" defaultValue={str(secret, "field", "password")} />
      </Field>
    </>
  );
}
export function OrderWorkflow({
  order,
  crew,
  locale,
  onChange,
}: {
  order: Row;
  crew: Row[];
  locale: Locale;
  onChange: () => void;
}) {
  const t = useText(locale),
    [workflow, setWorkflow] = useState<Row>({}),
    [revision, setRevision] = useState(0),
    [loadError, setLoadError] = useState("");
  const base = `/orders/${str(order, "id")}`,
    kind = str(order, "kind");
  const changed = () => {
    setRevision((v) => v + 1);
    onChange();
  };
  useEffect(() => {
    void request(`${base}/workflow`)
      .then(setWorkflow)
      .catch((e) => setLoadError(e.message));
  }, [base, revision, order.revision]);
  const mutation = useMutation(changed);
  return (
    <div className={styles.workflowForms}>
      {loadError && (
        <p className={styles.error} role="alert">
          {loadError}
        </p>
      )}
      <p className={styles.eyebrow}>
        {t("FACHABLAUF", "WORKFLOW")} / {workflowStateLabel(str(workflow, "state", "—"), locale)}
      </p>
      <details className={styles.panel}>
        <summary>{t("Arbeitsplan festlegen", "Set work plan")}</summary>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            void mutation.save(
              `${base}/plan`,
              {
                steps: String(f.get("steps")).split("\n").filter(Boolean),
                acceptanceCriteria: String(f.get("acceptanceCriteria")).split("\n").filter(Boolean),
              },
              order.revision,
            );
          }}
        >
          <Field label={t("Arbeitsschritte (einer je Zeile)", "Work steps (one per line)")}>
            <textarea name="steps" rows={3} required />
          </Field>
          <Field label={t("Abnahmekriterien", "Acceptance criteria")}>
            <textarea
              name="acceptanceCriteria"
              rows={3}
              required
              defaultValue={Array.isArray(order.acceptanceCriteria) ? order.acceptanceCriteria.join("\n") : ""}
            />
          </Field>
          <button disabled={mutation.busy}>{t("Neue Planversion speichern", "Save new plan version")}</button>
        </form>
      </details>
      <RunOrder order={order} locale={locale} onChange={changed} />
      <Coordination order={order} crew={crew} locale={locale} />
      {kind === "website" && <WebsitePanel base={base} workflow={workflow} locale={locale} onChange={changed} />}{" "}
      {kind === "incident" && <IncidentPanel base={base} workflow={workflow} locale={locale} onChange={changed} />}{" "}
      {kind === "finance" && <VoucherPanel base={base} locale={locale} onChange={changed} />}{" "}
      {kind === "research" && <ResearchPanel base={base} locale={locale} onChange={changed} />}
      {kind === "research" && <ResearchWatches order={order} locale={locale} />}
      <OrderModelRating orderId={str(order, "id")} locale={locale} />
      <Feedback state={mutation} locale={locale} />
      <span className={styles.srOnly}>{crew.length} crew profiles</span>
    </div>
  );
}
function RunOrder({ order, locale, onChange }: { order: Row; locale: Locale; onChange: () => void }) {
  const t = useText(locale),
    [models, setModels] = useState<Row[]>([]),
    [mandates, setMandates] = useState<Row[]>([]),
    [enabled, setEnabled] = useState(false);
  const mutation = useMutation(onChange);
  useEffect(() => {
    void Promise.all([list("/models"), list("/mandates"), request("/configuration")])
      .then(([models, mandates, config]) => {
        setModels(models);
        setMandates(mandates);
        setEnabled(config.liveExecutionEnabled === true);
      })
      .catch(() => setEnabled(false));
  }, []);
  return (
    <details className={styles.panel}>
      <summary>{t("Crew-Ausführung starten", "Start crew execution")}</summary>
      {!enabled && (
        <p className={styles.warning}>
          {t(
            "Live-Ausführung ist noch nicht aktiviert. Modellzugang und Budget unter Einstellungen prüfen.",
            "Live execution is not enabled. Review model access and budget in Settings.",
          )}
        </p>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          void mutation.save(
            `/orders/${str(order, "id")}/run`,
            { modelId: f.get("modelId"), mandateId: f.get("mandateId") },
            order.revision,
          );
        }}
      >
        <Field label={t("Modell", "Model")}>
          <select name="modelId" required>
            {models.map((m) => (
              <option key={str(m, "id")} value={str(m, "id")}>
                {str(m, "name", str(m, "id"))}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("Aktives Mandat", "Active mandate")}>
          <select name="mandateId" required>
            {mandates.map((m) => (
              <option key={str(m, "id")} value={str(m, "id")}>
                {str(m, "title", str(m, "id"))}
              </option>
            ))}
          </select>
        </Field>
        <Feedback state={mutation} locale={locale} />
        <button disabled={!enabled || !models.length || !mandates.length || mutation.busy}>
          {t("Innerhalb des Mandats ausführen", "Execute within mandate")}
        </button>
      </form>
    </details>
  );
}
function WebsitePanel({
  base,
  workflow,
  locale,
  onChange,
}: {
  base: string;
  workflow: Row;
  locale: Locale;
  onChange: () => void;
}) {
  const t = useText(locale),
    mutation = useMutation(onChange),
    [conceptCount, setConceptCount] = useState(5),
    [viewport, setViewport] = useState("desktop"),
    [anchor, setAnchor] = useState(""),
    [viewedVersion, setViewedVersion] = useState<string | null>(null),
    [pins, setPins] = useState<Row[]>([]),
    [pinError, setPinError] = useState("");
  const concepts = (workflow.concepts ?? []) as Row[],
    artifact = str(workflow, "artifactVersionId");
  const widths: Record<string, number> = { desktop: 1440, tablet: 1024, mobile: 390 };
  const versions = useRemote(`${base}/artifacts`);
  const displayedVersion = viewedVersion ?? artifact;
  useEffect(() => {
    setViewedVersion(null);
    setAnchor("");
  }, [artifact]);
  useEffect(() => {
    let active = true;
    void list(`${base}/website/pins`)
      .then((rows) => {
        if (active) {
          setPins(rows);
          setPinError("");
        }
      })
      .catch((error: Error) => {
        if (active) setPinError(error.message);
      });
    return () => {
      active = false;
    };
  }, [base, workflow]);
  const preview =
    displayedVersion && /^[a-f0-9-]{36}$/.test(displayedVersion)
      ? `http://127.0.0.1:8792/${displayedVersion}/`
      : str(workflow, "previewUrl");
  return (
    <>
      {workflow.state === "not_started" && (
        <form
          className={styles.panel}
          onSubmit={(e) => {
            e.preventDefault();
            void mutation.save(`${base}/website`, Object.fromEntries(new FormData(e.currentTarget)));
          }}
        >
          <h3>{t("Website-Briefing", "Website brief")}</h3>
          <Field label={t("Zielgruppe, Inhalt & Gestaltung", "Audience, content & design")}>
            <textarea name="briefing" rows={4} required />
          </Field>
          <Field label={t("Technologie", "Technology")}>
            <select name="stack">
              <option value="static">HTML / CSS / JavaScript</option>
              <option value="react">React</option>
              <option value="wordpress">WordPress</option>
            </select>
          </Field>
          <button disabled={mutation.busy}>{t("Briefing speichern", "Save brief")}</button>
        </form>
      )}
      {["briefing", "concepts"].includes(str(workflow, "state")) && (
        <details className={styles.panel}>
          <summary>{t("Ausgearbeitete Konzepte hinterlegen", "Add prepared concepts")}</summary>
          <p>
            {t(
              "Jede Richtung erhält ein eigenes Motiv, eine Begründung und ein tatsächliches HTML-Artefakt. Die Crew kann die Entwürfe im Auftrag erarbeiten.",
              "Each direction needs a distinct idea, rationale and actual HTML artifact. The crew can prepare concepts within the order.",
            )}
          </p>
          <Field label={t("Anzahl Varianten", "Number of variants")}>
            <input
              type="number"
              min={2}
              max={10}
              value={conceptCount}
              onChange={(e) => setConceptCount(Math.max(2, Math.min(10, Number(e.target.value))))}
            />
          </Field>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void mutation.save(`${base}/website/concepts`, {
                concepts: Array.from({ length: conceptCount }, (_, i) => ({
                  name: f.get(`name${i}`),
                  rationale: f.get(`rationale${i}`),
                  html: f.get(`html${i}`),
                })),
              });
            }}
          >
            {Array.from({ length: conceptCount }, (_, i) => (
              <fieldset key={i}>
                <legend>
                  {t("Richtung", "Direction")} {i + 1}
                </legend>
                <Field label={t("Name", "Name")}>
                  <input name={`name${i}`} required />
                </Field>
                <Field label={t("Gestalterische Begründung", "Design rationale")}>
                  <textarea name={`rationale${i}`} required />
                </Field>
                <Field label="HTML">
                  <textarea name={`html${i}`} required rows={4} spellCheck={false} />
                </Field>
              </fieldset>
            ))}
            <button disabled={mutation.busy}>{t("Konzepte versionieren", "Version concepts")}</button>
          </form>
        </details>
      )}
      {concepts.length > 0 && (
        <details className={styles.panel} open={!workflow.selectedConceptId}>
          <summary>
            {workflow.selectedConceptId
              ? t("Ausgewählte Richtung & weitere Konzepte", "Selected direction & other concepts")
              : t("Konzepte vergleichen", "Compare concepts")}{" "}
            ({concepts.length})
          </summary>
          <div className={styles.resourceList}>
            {concepts.map((concept) => (
              <article className={styles.resource} key={str(concept, "id")}>
                <h3>{str(concept, "name")}</h3>
                <p>{str(concept, "rationale")}</p>
                <ConceptPreview html={str(concept, "html")} name={str(concept, "name")} locale={locale} />
                <p className={styles.muted}>
                  {t(
                    "Statische Konzeptvorschau; Links sind deaktiviert.",
                    "Static concept preview; links are disabled.",
                  )}
                </p>
                <button
                  className={styles.secondary}
                  disabled={workflow.selectedConceptId === concept.id || mutation.busy}
                  onClick={() => void mutation.save(`${base}/website/select`, { conceptId: concept.id })}
                >
                  {workflow.selectedConceptId === concept.id
                    ? t("Ausgewählte Richtung", "Selected direction")
                    : t("Diese Richtung auswählen", "Select direction")}
                </button>
              </article>
            ))}
          </div>
        </details>
      )}
      {workflow.state === "selected" && (
        <button disabled={mutation.busy} onClick={() => void mutation.save(`${base}/website/build`, {})}>
          {t("Ausgewählte Website bauen", "Build selected website")}
        </button>
      )}
      {artifact && (
        <>
          <Field label={t("Vorschauversion vergleichen", "Compare preview version")}>
            <select
              value={displayedVersion}
              onChange={(e) => {
                setViewedVersion(e.target.value);
                setAnchor("");
              }}
            >
              <option value={artifact}>{t("Aktuelle Version", "Current version")}</option>
              {records(versions.data.items)
                .filter((item) => item.id !== artifact && item.mediaType === "text/html")
                .map((item) => (
                  <option key={str(item, "id")} value={str(item, "id")}>
                    {str(item, "createdAt")} · {str(item, "id")}
                  </option>
                ))}
            </select>
          </Field>
          <div className={styles.financeLinks}>
            <a href={`/api/v1/artifacts/${artifact}/package`} download>
              {t("Vollständiges Websitepaket herunterladen", "Download complete website package")}
            </a>
          </div>
          {workflow.stack === "wordpress" && (
            <p className={styles.warning}>
              {t(
                "Statische WordPress-Entwurfsvorschau. Sie bestätigt noch keinen laufenden WordPress-Betrieb.",
                "Static WordPress draft preview. It does not confirm a running WordPress installation.",
              )}
            </p>
          )}
          <div className={styles.toolbar}>
            {Object.keys(widths).map((v) => (
              <button
                key={v}
                className={styles.secondary}
                aria-pressed={viewport === v}
                onClick={() => {
                  setViewport(v);
                  setAnchor("");
                }}
              >
                {v === "desktop" ? "Desktop" : v === "tablet" ? "Tablet" : t("Mobil", "Mobile")}
              </button>
            ))}
          </div>
          {/^http:\/\/127\.0\.0\.1:8792\/[a-f0-9-]+\/$/.test(preview) && (
            <SitePreview
              key={`${displayedVersion}:${viewport}`}
              src={preview}
              width={widths[viewport]}
              version={displayedVersion}
              locale={locale}
              onSelect={setAnchor}
            />
          )}
          <p className={styles.muted}>
            {t("Artefaktversion", "Artifact version")}: {displayedVersion}
          </p>
          <form
            className={styles.panel}
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void mutation.save(`${base}/website/pins`, {
                artifactVersionId: displayedVersion,
                viewport: { width: widths[viewport], height: 650 },
                anchor: f.get("anchor"),
                comment: f.get("comment"),
                deferDispatch: true,
              });
            }}
          >
            <h3>{t("Versionsgebundenes Feedback", "Version-bound feedback")}</h3>
            <Field label={t("Elementanker (z. B. #hero)", "Element anchor (e.g. #hero)")}>
              <input name="anchor" value={anchor} onChange={(e) => setAnchor(e.target.value)} required />
            </Field>
            <Field label={t("Kommentar", "Comment")}>
              <textarea name="comment" required />
            </Field>
            <button disabled={mutation.busy}>{t("Feedback speichern", "Save feedback")}</button>
          </form>
          {pinError && (
            <p role="alert" className={styles.error}>
              {t("Feedbackliste konnte nicht aktualisiert werden: ", "Could not refresh feedback list: ")}
              {pinError}
            </p>
          )}
          {pins.some((pin) => pin.state === "draft") && (
            <button
              disabled={mutation.busy}
              onClick={() =>
                void mutation.save(`${base}/website/feedback/submit`, {
                  pinIds: pins
                    .filter((pin) => pin.state === "draft")
                    .slice(0, 50)
                    .map((pin) => pin.id),
                })
              }
            >
              {t("Gesammeltes Feedback zur Umsetzung geben", "Submit collected feedback for implementation")}
            </button>
          )}
          {pins.map((pin) => (
            <article className={styles.resource} key={str(pin, "id")}>
              <p>{str(pin, "comment")}</p>
              <p>
                {pin.state === "draft"
                  ? t("Gesammelt – noch nicht beauftragt", "Collected — not submitted yet")
                  : pin.state === "resolved"
                    ? t("Umsetzung geprüft", "Implementation reviewed")
                    : t("Zur Umsetzung vorgelegt", "Submitted for implementation")}
              </p>
              <p className={styles.muted}>
                {str(pin, "anchor")} ·{" "}
                {pin.artifactVersionId === artifact
                  ? t("Aktuelle Version", "Current version")
                  : t("Ältere Version", "Older version")}
              </p>
              {pin.state === "open" && displayedVersion === artifact && workflow.state !== "selected" && (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    const f = new FormData(event.currentTarget);
                    void mutation.save(`${base}/website/pins/${str(pin, "id")}/resolve`, {
                      artifactVersionId: artifact,
                      evidence: f.get("evidence"),
                    });
                  }}
                >
                  <Field label={t("Nachweis der Nachbesserung", "Evidence of resolution")}>
                    <textarea name="evidence" required />
                  </Field>
                  <button className={styles.secondary} disabled={mutation.busy}>
                    {t("Feedback als geprüft erledigen", "Resolve reviewed feedback")}
                  </button>
                </form>
              )}
            </article>
          ))}
          {displayedVersion === artifact && ["built", "reviewed"].includes(str(workflow, "state")) && (
            <details className={styles.panel}>
              <summary>{t("Manuelle Prüfung protokollieren", "Record a manual review")}</summary>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  void mutation.save(`${base}/website/review`, {
                    artifactVersionId: artifact,
                    checks: ["mobile", "functional", "quality"].map((name) => ({
                      name,
                      passed: f.get(`${name}Passed`) === "on",
                      evidence: f.get(`${name}Evidence`),
                    })),
                  });
                }}
              >
                {[
                  ["mobile", t("Mobile Bedienung", "Mobile usability")],
                  ["functional", t("Funktion", "Functionality")],
                  ["quality", t("Qualität", "Quality")],
                ].map(([name, label]) => (
                  <fieldset key={name}>
                    <legend>{label}</legend>
                    <Field label={`${label} · ${t("Prüfbeleg", "Evidence")}`}>
                      <textarea name={`${name}Evidence`} required />
                    </Field>
                    <label className={styles.check}>
                      <input name={`${name}Passed`} type="checkbox" />
                      {label} · {t("bestanden", "passed")}
                    </label>
                  </fieldset>
                ))}
                <p className={styles.muted}>
                  {t("Wird als deine menschliche Prüfung erfasst.", "Recorded as your human review.")}
                </p>
                <button disabled={mutation.busy}>{t("Prüfung speichern", "Save review")}</button>
              </form>
            </details>
          )}
          {displayedVersion === artifact && workflow.state === "reviewed" && (
            <div className={styles.panel}>
              <h3>{t("Geprüfte Version abnehmen", "Accept reviewed version")}</h3>
              <p>
                {t(
                  "Die Abnahme gilt für diese Artefaktversion. Veröffentlichung ist eine separate Entscheidung mit Ziel, Hash und Rückweg.",
                  "Acceptance applies to this artifact version. Publication is a separate decision with target, hash and rollback.",
                )}
              </p>
              <button
                disabled={mutation.busy}
                onClick={() => void mutation.save(`${base}/website/accept`, { artifactVersionId: artifact })}
              >
                {t("Diese Version abnehmen", "Accept this version")}
              </button>
            </div>
          )}
        </>
      )}
      <Hosting base={base} workflow={workflow} locale={locale} onChange={onChange} />
      <WebsiteCare base={base} locale={locale} />
      <Feedback state={mutation} locale={locale} />
    </>
  );
}
function IncidentPanel({
  base,
  workflow,
  locale,
  onChange,
}: {
  base: string;
  workflow: Row;
  locale: Locale;
  onChange: () => void;
}) {
  const t = useText(locale),
    mutation = useMutation(onChange);
  return (
    <>
      {workflow.state === "not_started" ? (
        <form
          className={styles.panel}
          onSubmit={(e) => {
            e.preventDefault();
            void mutation.save(`${base}/incident`, Object.fromEntries(new FormData(e.currentTarget)));
          }}
        >
          <h3>{t("Vorfall zuordnen", "Assign incident")}</h3>
          <Field label={t("Zielsystem-ID", "Target system ID")}>
            <input name="targetId" required />
          </Field>
          <Field label={t("Beobachtung", "Observation")}>
            <textarea name="summary" required />
          </Field>
          <button disabled={mutation.busy}>{t("Vorfall initialisieren", "Initialize incident")}</button>
        </form>
      ) : (
        <>
          <p>
            {t("Zielsystem", "Target system")}: {str(workflow, "targetId")}
          </p>
          <form
            className={styles.panel}
            onSubmit={(e) => {
              e.preventDefault();
              void mutation.save(`${base}/incident/diagnosis`, Object.fromEntries(new FormData(e.currentTarget)));
            }}
          >
            <Field label={t("Ursachenstand", "Cause confidence")}>
              <select name="causeStatus">
                <option value="unknown">{t("Unbekannt", "Unknown")}</option>
                <option value="suspected">{t("Vermutet", "Suspected")}</option>
                <option value="confirmed">{t("Belegt", "Confirmed")}</option>
              </select>
            </Field>
            <Field label={t("Diagnose", "Diagnosis")}>
              <textarea name="explanation" required rows={3} />
            </Field>
            <Field label={t("Beleg und Quellenzeitpunkt", "Evidence and source timestamp")}>
              <textarea name="evidence" required />
            </Field>
            <button disabled={mutation.busy}>{t("Diagnose protokollieren", "Record diagnosis")}</button>
          </form>
          <ol>
            {(Array.isArray(workflow.timeline) ? (workflow.timeline as Row[]) : []).map((event, index) => (
              <li key={index}>
                <strong>{str(event, "kind")}</strong> · {str(event, "at")}
              </li>
            ))}
          </ol>
          <details className={styles.panel}>
            <summary>{t("Präventionsauftrag verknüpfen", "Link prevention order")}</summary>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                void mutation.save(`${base}/incident/prevention`, {
                  goal: f.get("goal"),
                  budgetLimitUsdMicros: String(Math.round(Number(f.get("budget")) * 1e6)),
                });
              }}
            >
              <Field label={t("Präventionsziel", "Prevention goal")}>
                <textarea name="goal" required />
              </Field>
              <Field label={t("Kostenrahmen USD", "Budget USD")}>
                <input name="budget" type="number" min="0" step=".01" defaultValue="0" required />
              </Field>
              <button disabled={mutation.busy}>{t("Folgeauftrag anlegen", "Create follow-up order")}</button>
            </form>
          </details>
        </>
      )}
      {workflow.state !== "not_started" && <IncidentOperations base={base} locale={locale} onChange={onChange} />}
      <Feedback state={mutation} locale={locale} />
    </>
  );
}
function VoucherPanel({ base, locale, onChange }: { base: string; locale: Locale; onChange: () => void }) {
  const t = useText(locale),
    mutation = useMutation(onChange),
    [voucher, setVoucher] = useState(""),
    [originalFile, setOriginalFile] = useState<File | null>(null);
  const documents = useRemote("/finance"),
    entries = records(documents.data.vouchers).filter((item) => item.orderId === base.split("/")[2]),
    selected = entries.find((item) => item.id === voucher);
  return (
    <>
      {entries.length > 0 && (
        <Field label={t("Gespeicherten Beleg auswählen", "Select stored document")}>
          <select
            value={voucher}
            onChange={(event) => {
              setVoucher(event.target.value);
              setOriginalFile(null);
            }}
          >
            <option value="">{t("Neuen Beleg erfassen", "Record new document")}</option>
            {entries.map((item) => (
              <option key={str(item, "id")} value={str(item, "id")}>
                {str((item.invoice as Row) ?? {}, "reference", str(item, "id"))}
              </option>
            ))}
          </select>
        </Field>
      )}
      <div className={styles.documentWorkspace}>
        <DocumentPreview file={originalFile} voucher={selected} locale={locale} />
        <div>
          {!voucher && (
            <form
              className={styles.panel}
              onSubmit={async (e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                const file = f.get("original") as File;
                if (!file || file.size > 700000) return;
                const bytes = new Uint8Array(await file.arrayBuffer());
                const originalSha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
                  .map((b) => b.toString(16).padStart(2, "0"))
                  .join("");
                let binary = "";
                for (const byte of bytes) binary += String.fromCharCode(byte);
                const result = await mutation.save(`${base}/finance/vouchers`, {
                  originalSha256,
                  originalBase64: btoa(binary),
                  mediaType: file.type,
                  invoice: {
                    id: f.get("invoiceId"),
                    supplierId: f.get("supplierId"),
                    ...(f.get("direction") ? { direction: f.get("direction") } : {}),
                    reference: f.get("reference"),
                    currency: f.get("currency"),
                    totalMinor: String(Math.round(Number(f.get("total")) * 100)),
                    paidMinor: String(Math.round(Number(f.get("paid")) * 100)),
                    dueAt: new Date(String(f.get("dueAt"))).toISOString(),
                    observedAt: new Date(String(f.get("observedAt"))).toISOString(),
                    source: f.get("source"),
                    disputed: f.get("disputed") === "on",
                    paymentPause: f.get("paymentPause") === "on",
                  },
                });
                if (result) {
                  setVoucher(str(result, "voucherId"));
                  setOriginalFile(null);
                  documents.reload();
                }
              }}
            >
              <h3>{t("Quellenbeleg zuordnen", "Classify source document")}</h3>
              <Field
                label={t(
                  "Originalbeleg (PDF, PNG, JPEG; höchstens 700 KB)",
                  "Original document (PDF, PNG, JPEG; up to 700 KB)",
                )}
              >
                <input
                  name="original"
                  type="file"
                  accept="application/pdf,image/png,image/jpeg"
                  required
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    setOriginalFile(file ?? null);
                    event.currentTarget.setCustomValidity(
                      file && file.size > 700000 ? t("Die Datei ist größer als 700 KB.", "File exceeds 700 KB.") : "",
                    );
                  }}
                />
              </Field>
              {[
                ["invoiceId", t("Rechnungs-ID", "Invoice ID")],
                ["supplierId", t("Lieferanten-ID", "Supplier ID")],
                ["reference", t("Rechnungsnummer", "Invoice reference")],
                ["source", t("Datenquelle / Belegreferenz", "Data source / document reference")],
              ].map(([name, label]) => (
                <Field key={name} label={label}>
                  <input name={name} required pattern={name === "hash" ? "[a-f0-9]{64}" : undefined} />
                </Field>
              ))}
              <Field label={t("Forderung oder Verbindlichkeit", "Receivable or payable")}>
                <select name="direction" defaultValue="">
                  <option value="">{t("Noch ungeklärt", "Not classified yet")}</option>
                  <option value="receivable">{t("Forderung – Zahlung an uns", "Receivable – payment to us")}</option>
                  <option value="payable">{t("Verbindlichkeit – Zahlung von uns", "Payable – payment from us")}</option>
                </select>
              </Field>
              <Field label={t("Währung", "Currency")}>
                <select name="currency">
                  <option>EUR</option>
                  <option>USD</option>
                  <option>GBP</option>
                  <option>CHF</option>
                </select>
              </Field>
              <Field label={t("Rechnungsbetrag", "Invoice total")}>
                <input name="total" type="number" min="0" step=".01" required />
              </Field>
              <Field label={t("Belegt bezahlt", "Confirmed paid")}>
                <input name="paid" type="number" min="0" step=".01" required />
              </Field>
              <Field label={t("Fällig am", "Due date")}>
                <input name="dueAt" type="date" required />
              </Field>
              <Field label={t("Geprüfter Datenstand", "Verified data timestamp")}>
                <input name="observedAt" type="datetime-local" required />
              </Field>
              <label className={styles.check}>
                <input name="disputed" type="checkbox" />
                {t("Strittig", "Disputed")}
              </label>
              <label className={styles.check}>
                <input name="paymentPause" type="checkbox" />
                {t("Zahlungspause", "Payment pause")}
              </label>
              <button disabled={mutation.busy}>{t("Beleg erfassen", "Record document")}</button>
            </form>
          )}
          {selected && (
            <section className={styles.panel}>
              <h3>{t("Gespeicherte Zuordnung", "Stored classification")}</h3>
              <p>{str((selected.invoice as Row) ?? {}, "reference")}</p>
              <p>
                {t("Quelle", "Source")}: {str((selected.invoice as Row) ?? {}, "source")}
              </p>
              <p>
                {t("Datenstand", "Data timestamp")}: {str((selected.invoice as Row) ?? {}, "observedAt")}
              </p>
              <Correction voucher={voucher} locale={locale} />
            </section>
          )}
        </div>
      </div>
      {voucher && (
        <>
          <p>
            {t("Beleg gespeichert", "Document recorded")}: {voucher}
          </p>
          <form
            className={styles.panel}
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void mutation.save(`/finance/vouchers/${voucher}/payment`, {
                recipient: f.get("recipient"),
                bankAccount: f.get("bankAccount"),
                reference: f.get("reference"),
                amountMinor: String(Math.round(Number(f.get("amount")) * 100)),
              });
            }}
          >
            <h3>{t("Zahlung vorbereiten", "Prepare payment")}</h3>
            {[
              ["recipient", t("Empfänger", "Recipient")],
              ["bankAccount", t("Bankverbindung", "Bank account")],
              ["reference", t("Verwendungszweck", "Reference")],
            ].map(([name, label]) => (
              <Field key={name} label={label}>
                <input name={name} required />
              </Field>
            ))}
            <Field label={t("Offener Betrag", "Outstanding amount")}>
              <input name="amount" type="number" min="0" step=".01" required />
            </Field>
            <p className={styles.warning}>
              {t(
                "Dies bereitet eine Zahlung vor. Es führt keine Zahlung aus und markiert keinen Beleg als bezahlt.",
                "This prepares a payment. It does not execute payment or mark the invoice paid.",
              )}
            </p>
            <button disabled={mutation.busy}>{t("Vorbereitung speichern", "Save preparation")}</button>
          </form>
        </>
      )}
      <Feedback state={mutation} locale={locale} />
    </>
  );
}
function Correction({ voucher, locale }: { voucher: string; locale: Locale }) {
  const t = useText(locale),
    mutation = useMutation(),
    [reuse, setReuse] = useState(false),
    [field, setField] = useState("accountDatevId");
  return (
    <form
      className={styles.panel}
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        void mutation.save(`/finance/vouchers/${voucher}/correction`, {
          field,
          value: field === "taxRuleId" ? String(f.get("value")) : Number(f.get("value")),
          source: f.get("source"),
          reuse,
          ...(reuse ? { scopeDescription: f.get("scopeDescription") } : {}),
        });
      }}
    >
      <h3>{t("Zuordnung korrigieren", "Correct classification")}</h3>
      <p>
        {t(
          "Korrigiert die Zuordnung für den nächsten sevdesk-Entwurf. Originaldatei, Rechnungsbetrag und Zahlungsstand bleiben belegt. Bereits zur Übertragung gebundene Belege benötigen einen eigenen abgestimmten Korrekturvorgang.",
          "Corrects classification for the next sevdesk draft. The original, invoice amount and payment record remain source-bound. Documents already bound for transfer require a separate reconciled correction process.",
        )}
      </p>
      <Field label={t("Feld", "Field")}>
        <select name="field" value={field} onChange={(event) => setField(event.target.value)}>
          <option value="accountDatevId">{t("DATEV-Konto-ID", "DATEV account ID")}</option>
          <option value="sevdeskSupplierId">{t("sevdesk-Lieferanten-ID", "sevdesk supplier ID")}</option>
          <option value="taxRuleId">{t("sevdesk-Steuerregel", "sevdesk tax rule")}</option>
          <option value="taxRate">{t("Steuersatz in Prozent", "Tax rate percent")}</option>
        </select>
      </Field>
      <Field label={t("Korrigierter Wert", "Corrected value")}>
        {field === "taxRuleId" ? (
          <select name="value" required defaultValue="">
            <option value="">{t("Regel auswählen", "Select rule")}</option>
            {["1", "2", "3", "4", "5", "11"].map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        ) : (
          <input
            key={field}
            name="value"
            type="number"
            min={field === "taxRate" ? 0 : 1}
            max={field === "taxRate" ? 100 : undefined}
            step={field === "taxRate" ? "any" : 1}
            required
          />
        )}
      </Field>
      <Field label={t("Begründung / Quelle", "Reason / source")}>
        <textarea name="source" required />
      </Field>
      <label className={styles.check}>
        <input type="checkbox" checked={reuse} onChange={(e) => setReuse(e.target.checked)} />
        {t("Als wiederverwendbare Regel vorschlagen", "Propose reusable rule")}
      </label>
      {reuse && (
        <Field label={t("Geltungsbereich der vorgeschlagenen Regel", "Scope of proposed rule")}>
          <textarea name="scopeDescription" required />
        </Field>
      )}
      <Feedback state={mutation} locale={locale} />
      <button disabled={mutation.busy}>
        {reuse
          ? t("Korrigieren & Regel vorschlagen", "Correct & propose rule")
          : t("Nur diesen Beleg korrigieren", "Correct this document only")}
      </button>
    </form>
  );
}
function ResearchPanel({ base, locale, onChange }: { base: string; locale: Locale; onChange: () => void }) {
  const t = useText(locale),
    [sources, setSources] = useState<Row[]>([]),
    [reports, setReports] = useState<Row[]>([]),
    [refresh, setRefresh] = useState(0),
    [loadError, setLoadError] = useState("");
  const mutation = useMutation(() => {
    setRefresh((v) => v + 1);
    onChange();
  });
  useEffect(() => {
    void Promise.all([list(`${base}/research/sources`), list(`${base}/research`)])
      .then(([s, r]) => {
        setSources(s);
        setReports(r);
        setLoadError("");
      })
      .catch((e) => setLoadError(e.message));
  }, [base, refresh]);
  return (
    <>
      <p>
        {t(
          "Das Ergebnis trennt Empfehlung, Belege, Annahmen und Lücken. Ein externer Ablagefehler bleibt offen.",
          "The result separates recommendations, evidence, assumptions and gaps. External delivery failures remain unresolved.",
        )}
      </p>
      {loadError && (
        <p role="alert" className={styles.error}>
          {loadError}
        </p>
      )}
      <details className={styles.panel}>
        <summary>{t("Quelle für diesen Auftrag prüfen", "Check a source for this order")}</summary>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void mutation.save(`${base}/research/sources`, Object.fromEntries(new FormData(e.currentTarget)));
          }}
        >
          <Field label={t("Titel der Quelle", "Source title")}>
            <input name="title" required />
          </Field>
          <Field label="URL">
            <input name="url" type="url" required />
          </Field>
          <Field label={t("Verbindungs-ID", "Connection ID")}>
            <input name="targetId" required />
          </Field>
          <Field label={t("Mandats-ID", "Mandate ID")}>
            <input name="mandateId" required />
          </Field>
          <button disabled={mutation.busy}>{t("Quelle abrufen", "Fetch source")}</button>
        </form>
      </details>
      <div className={styles.resourceList}>
        {sources.map((source) => (
          <article key={str(source, "id")} className={styles.resource}>
            <h3>{str(source, "title")}</h3>
            <p>{str(source, "url")}</p>
            <p className={styles.muted}>
              {str(source, "observedAt")} ·{" "}
              {source.status === "available"
                ? t("Erreichbar", "Available")
                : t("Nicht erreichbar – unvollständig", "Unavailable – incomplete")}
            </p>
          </article>
        ))}
      </div>
      {sources.some((s) => s.status === "available") && (
        <details className={styles.panel}>
          <summary>{t("Ergebnisdokument versionieren", "Version result document")}</summary>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void mutation.save(`${base}/research`, {
                title: f.get("title"),
                recommendation: f.get("recommendation"),
                reasons: [{ text: f.get("reason"), sourceIds: f.getAll("sourceId") }],
                comparison: f.get("comparison"),
                methodology: f.get("methodology"),
                sources,
                assumptions: String(f.get("assumptions")).split("\n").filter(Boolean),
                gaps: String(f.get("gaps")).split("\n").filter(Boolean),
                requiredDelivery: f.get("requiredDelivery"),
              });
            }}
          >
            {[
              ["title", t("Dokumenttitel", "Document title")],
              ["recommendation", t("Empfehlung", "Recommendation")],
              ["reason", t("Wesentliche Begründung", "Main supporting reason")],
              ["comparison", t("Vergleich", "Comparison")],
              ["methodology", t("Methodik", "Methodology")],
              ["assumptions", t("Annahmen (eine je Zeile)", "Assumptions (one per line)")],
              ["gaps", t("Lücken (eine je Zeile)", "Gaps (one per line)")],
            ].map(([name, label]) => (
              <Field key={name} label={label}>
                <textarea
                  name={name}
                  required={!["assumptions", "gaps"].includes(name)}
                  rows={name === "title" ? 1 : 3}
                />
              </Field>
            ))}
            <fieldset>
              <legend>{t("Belege für diese Begründung", "Sources supporting this reason")}</legend>
              {sources
                .filter((s) => s.status === "available")
                .map((source) => (
                  <label className={styles.check} key={str(source, "id")}>
                    <input type="checkbox" name="sourceId" value={str(source, "id")} />
                    {str(source, "title")}
                  </label>
                ))}
            </fieldset>
            <Field label={t("Erforderliche Ablage", "Required delivery")}>
              <select name="requiredDelivery">
                <option value="internal">{t("Interne Ablage", "Internal storage")}</option>
                <option value="nextcloud">Nextcloud</option>
                <option value="gdrive">Google Drive</option>
                <option value="git">Git</option>
              </select>
            </Field>
            <button disabled={mutation.busy}>{t("Echte Dokumentversion erstellen", "Create document version")}</button>
          </form>
        </details>
      )}
      {reports.map((report) => (
        <article className={styles.panel} key={str(report, "id")}>
          <h3>{str(report, "title")}</h3>
          <p>{str(report, "recommendation")}</p>
          <p>
            {t("Ablagestatus", "Delivery status")}:{" "}
            {str((report.deliveryRecord ?? {}) as Row, "state", str(report, "delivery"))}
          </p>
          {["approval", "effect_unknown", "conflict"].includes(str((report.deliveryRecord ?? {}) as Row, "state")) && (
            <p className={styles.warning}>
              {str((report.deliveryRecord ?? {}) as Row, "state") === "approval"
                ? t(
                    "Freigabe unter Entscheidungen prüfen, dann dieselbe Ablage fortsetzen.",
                    "Review approval in Decisions, then resume the same delivery.",
                  )
                : str((report.deliveryRecord ?? {}) as Row, "state") === "conflict"
                  ? t(
                      "Zielversion prüfen, bevor ein weiterer Ablageversuch erfolgt.",
                      "Check destination revision before another delivery attempt.",
                    )
                  : t(
                      "Wirkung zuerst abgleichen. Kein automatischer Wiederholungsversuch.",
                      "Reconcile effects first. No automatic retry.",
                    )}
            </p>
          )}
          <p className={styles.muted}>
            {str(report, "completeness")} · {t("Version", "Version")} {str(report, "id")}
          </p>
          {report.requiredDelivery !== "internal" && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const data = Object.fromEntries(new FormData(e.currentTarget));
                void mutation.save(`${base}/research/deliver`, {
                  artifactVersionId: report.id,
                  ...Object.fromEntries(Object.entries(data).filter(([, v]) => v !== "")),
                });
              }}
            >
              <h3>{t("Externe Version ablegen", "Deliver external version")}</h3>
              <Field label={t("Format", "Format")}>
                <select name="nativeFormat" defaultValue="">
                  <option value="">{t("Markdown-Datei", "Markdown file")}</option>
                  <option value="google-doc">Google Docs</option>
                </select>
              </Field>
              {[
                ["targetId", t("Verbindungs-ID", "Connection ID")],
                ["mandateId", t("Mandats-ID", "Mandate ID")],
                ["path", t("Nextcloud-Zielpfad", "Nextcloud destination path")],
                ["folderId", t("Google-Drive-Ordner-ID", "Google Drive folder ID")],
                [
                  "expectedRevision",
                  t("Erwartete bestehende Version (optional)", "Expected existing revision (optional)"),
                ],
              ].map(([name, label]) => (
                <Field key={name} label={label}>
                  <input name={name} required={["targetId", "mandateId"].includes(name)} />
                </Field>
              ))}
              <button
                disabled={mutation.busy || str((report.deliveryRecord ?? {}) as Row, "state") === "effect_unknown"}
              >
                {t("Ablage ausführen", "Deliver version")}
              </button>
            </form>
          )}
        </article>
      ))}
      <Feedback state={mutation} locale={locale} />
    </>
  );
}

export function SchedulePanel({ crew, locale }: { crew: Row[]; locale: Locale }) {
  const t = useText(locale),
    mutation = useMutation();
  return (
    <details className={styles.panel}>
      <summary>{t("Neue Routine", "New schedule")}</summary>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          void mutation.save("/schedules", {
            cron: f.get("cron"),
            timezone: f.get("timezone"),
            enabled: f.get("enabled") === "on",
            goal: f.get("goal"),
            kind: f.get("kind"),
            leadEmployeeId: f.get("leadEmployeeId"),
            budgetLimitUsdMicros: String(Math.round(Number(f.get("budget")) * 1e6)),
            mandateId: f.get("mandateId"),
            maxActiveOrders: Number(f.get("maxActiveOrders")),
          });
        }}
      >
        <Field label={t("Ziel", "Goal")}>
          <textarea name="goal" required />
        </Field>
        <Field label={t("Zeitplan (Cron)", "Schedule (Cron)")}>
          <input name="cron" placeholder="0 9 * * 1-5" required />
        </Field>
        <Field label={t("Zeitzone", "Timezone")}>
          <input name="timezone" defaultValue="Europe/Berlin" required />
        </Field>
        <Field label={t("Ablauf", "Workflow")}>
          <select name="kind">
            <option value="research">{t("Recherche", "Research")}</option>
            <option value="website">Website</option>
            <option value="incident">IT</option>
            <option value="finance">{t("Finanzen", "Finance")}</option>
          </select>
        </Field>
        <Field label="Lead">
          <select name="leadEmployeeId" required>
            {crew.map((c) => (
              <option key={str(c, "id")} value={str(c, "id")}>
                {str(c, "displayName")}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("Kostenrahmen je Auftrag USD", "Budget per order USD")}>
          <input name="budget" type="number" min="0" step=".01" defaultValue="0" required />
        </Field>
        <Field label={t("Mandats-ID", "Mandate ID")}>
          <input name="mandateId" required />
        </Field>
        <Field label={t("Maximal gleichzeitige Aufträge", "Maximum concurrent orders")}>
          <input name="maxActiveOrders" type="number" min={1} max={3} defaultValue={1} required />
        </Field>
        <label className={styles.check}>
          <input type="checkbox" name="enabled" />
          {t("Routine aktivieren", "Enable schedule")}
        </label>
        <p className={styles.muted}>
          {t(
            "Nach Ausfall höchstens ein Nachholauftrag. Doppelte Sommerzeit-Stunde läuft einmal; ausgelassene Uhrzeit zum nächsten gültigen Zeitpunkt.",
            "At most one catch-up after downtime. Duplicate DST hours run once; skipped times move to the next valid time.",
          )}
        </p>
        <Feedback state={mutation} locale={locale} />
        <button disabled={mutation.busy}>{t("Routine speichern", "Save schedule")}</button>
      </form>
    </details>
  );
}
export function MandatePanel({ company, locale }: { company: Row; locale: Locale }) {
  const t = useText(locale),
    mutation = useMutation(),
    [areas, setAreas] = useState<Row[]>([]);
  useEffect(() => {
    void list("/areas").then(setAreas);
  }, []);
  const tools = [
    "coordination.consult",
    "browser.inspect",
    "workspace.list",
    "workspace.read",
    "workspace.apply_patch",
    "workspace.test_fixture",
    "artifact.stage",
    "artifact.deliver",
    "approval.request",
    "website.revise",
    "research.source",
    "research.report",
    "research.deliver",
    "research.fetch",
    "research.search",
    "nextcloud.read",
    "nextcloud.list",
    "nextcloud.write",
    "gdrive.read",
    "gdrive.create",
    "website.publish",
    "incident.repair",
    "incident.check",
    "incident.customer_message",
    "tactical.agents.read",
    "tactical.alerts.read",
    "tactical.script.run",
    "proxmox.nodes.read",
    "proxmox.guests.read",
    "proxmox.guest.action",
    "sevdesk.invoices.read",
    "sevdesk.vouchers.read",
    "sevdesk.voucher.upload",
    "sevdesk.reminder.create",
    "sevdesk.reminder.send",
    "graph.users.read",
    "graph.mail.send",
    "telegram.send",
    "discord.send",
  ];
  return (
    <details className={styles.panel}>
      <summary>{t("Konkretes Mandat erteilen", "Grant concrete mandate")}</summary>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget),
            constraints = Object.fromEntries(
              String(f.get("constraints"))
                .split("\n")
                .filter(Boolean)
                .map((line) => {
                  const i = line.indexOf("=");
                  return [line.slice(0, i).trim(), line.slice(i + 1).trim()];
                }),
            );
          void mutation.save("/mandates", {
            id: crypto.randomUUID(),
            version: 1,
            scope: { companyId: company.id, areaId: f.get("areaId") },
            allowedToolIds: f.getAll("tool"),
            targetIds: String(f.get("targetIds")).split("\n").filter(Boolean),
            parameterConstraints: constraints,
            expiresAt: new Date(String(f.get("expiresAt"))).toISOString(),
            maxAttempts: Number(f.get("maxAttempts")),
            maxDurationSeconds: Number(f.get("maxDurationSeconds")),
            maxCostUsdMicros: String(Math.round(Number(f.get("budget")) * 1e6)),
          });
        }}
      >
        <Field label={t("Bereich", "Area")}>
          <select name="areaId" required>
            {areas.map((a) => (
              <option key={str(a, "id")} value={str(a, "id")}>
                {str(a, "name")}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("Erlaubte Ziel-IDs (eine je Zeile)", "Allowed target IDs (one per line)")}>
          <textarea name="targetIds" required rows={3} />
        </Field>
        <fieldset>
          <legend>{t("Erlaubte Werkzeuge", "Allowed tools")}</legend>
          <div className={styles.toolGrid}>
            {tools.map((tool) => (
              <label className={styles.check} key={tool}>
                <input type="checkbox" name="tool" value={tool} />
                {tool}
              </label>
            ))}
          </div>
        </fieldset>
        <Field
          label={t(
            "Feste Parameter (Feld=Wert, eine Bindung je Zeile)",
            "Fixed parameters (field=value, one constraint per line)",
          )}
        >
          <textarea name="constraints" rows={3} />
          <span className={styles.muted}>
            {t(
              "Ohne Bindung dürfen Argumente innerhalb der gewählten Werkzeuge und Ziele variieren. Externe Wirkungen können zusätzliche Freigaben erfordern.",
              "Without constraints, arguments may vary within the selected tools and targets. External effects may require additional approval.",
            )}
          </span>
        </Field>
        <Field label={t("Gültig bis", "Expires at")}>
          <input name="expiresAt" type="datetime-local" required />
        </Field>
        <Field label={t("Maximale Versuche", "Maximum attempts")}>
          <input name="maxAttempts" type="number" min={1} defaultValue={1} required />
        </Field>
        <Field label={t("Maximale Laufzeit in Sekunden", "Maximum duration in seconds")}>
          <input name="maxDurationSeconds" type="number" min={1} defaultValue={300} required />
        </Field>
        <Field label={t("Maximale Kosten USD", "Maximum cost USD")}>
          <input name="budget" type="number" min={0} step=".01" defaultValue="0" required />
        </Field>
        <Feedback state={mutation} locale={locale} />
        <button disabled={mutation.busy}>{t("Dieses Mandat erteilen", "Grant this mandate")}</button>
      </form>
    </details>
  );
}
export function KnowledgePanel({ crew, locale }: { crew: Row[]; locale: Locale }) {
  const t = useText(locale),
    [entries, setEntries] = useState<Row[]>([]),
    [refresh, setRefresh] = useState(0),
    [error, setError] = useState("");
  const mutation = useMutation(() => setRefresh((v) => v + 1));
  useEffect(() => {
    void list("/knowledge")
      .then(setEntries)
      .catch((e) => setError(e.message));
  }, [refresh]);
  return (
    <>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {!entries.length && (
        <p className={styles.empty}>
          {t("Noch kein geprüftes Wissen gespeichert.", "No reviewed knowledge stored yet.")}
        </p>
      )}
      {entries.map((entry) => (
        <article key={str(entry, "id")} className={styles.panel}>
          <h3>{str(entry, "title")}</h3>
          <p>{str(entry, "content")}</p>
          <p className={styles.muted}>
            {str(entry, "type")} · {str(entry, "status")} · {t("Version", "Version")} {String(entry.version ?? 1)}
          </p>
          {entry.status === "proposed" && (
            <p>
              {t("Wartet auf Fachprüfung des verantwortlichen Leads.", "Waiting for review by the responsible lead.")}
            </p>
          )}
          {entry.status === "lead_reviewed" && entry.type === "company_rule" && (
            <div className={styles.actions}>
              <button
                disabled={mutation.busy}
                onClick={() =>
                  void mutation.save(`/knowledge/${str(entry, "id")}/decision`, { decision: "approve" }, entry.revision)
                }
              >
                {t("Diese Firmenregel freigeben", "Approve this company rule")}
              </button>
              <button
                className={styles.secondary}
                disabled={mutation.busy}
                onClick={() =>
                  void mutation.save(`/knowledge/${str(entry, "id")}/decision`, { decision: "reject" }, entry.revision)
                }
              >
                {t("Ablehnen", "Reject")}
              </button>
            </div>
          )}
        </article>
      ))}
      <details className={styles.panel}>
        <summary>{t("Wissen zur Fachprüfung vorschlagen", "Propose knowledge for lead review")}</summary>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            void mutation.save("/knowledge", {
              title: f.get("title"),
              content: f.get("content"),
              type: f.get("type"),
              leadEmployeeId: f.get("leadEmployeeId"),
              sourceArtifactVersionIds: String(f.get("sources")).split("\n").filter(Boolean),
            });
          }}
        >
          <Field label={t("Titel", "Title")}>
            <input name="title" required />
          </Field>
          <Field label={t("Inhalt", "Content")}>
            <textarea name="content" required rows={4} />
          </Field>
          <Field label={t("Geltung", "Type")}>
            <select name="type">
              <option value="specialist">{t("Fachwissen im Bereich", "Specialist knowledge in this area")}</option>
              <option value="company_rule">{t("Vorgeschlagene Firmenregel", "Proposed company rule")}</option>
            </select>
          </Field>
          <Field label={t("Verantwortlicher Lead", "Responsible lead")}>
            <select name="leadEmployeeId" required>
              {crew.map((person) => (
                <option key={str(person, "id")} value={str(person, "id")}>
                  {str(person, "displayName")}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t("Quellartefaktversionen (eine ID je Zeile)", "Source artifact versions (one ID per line)")}>
            <textarea name="sources" required />
          </Field>
          <button disabled={mutation.busy}>{t("Vorschlag speichern", "Save proposal")}</button>
        </form>
      </details>
      <Feedback state={mutation} locale={locale} />
    </>
  );
}
export function BackupPanel({ locale }: { locale: Locale }) {
  const t = useText(locale),
    [recovery, setRecovery] = useState<Row>({}),
    [backup, setBackup] = useState<Row | null>(null),
    [refresh, setRefresh] = useState(0);
  const mutation = useMutation(() => setRefresh((v) => v + 1));
  useEffect(() => {
    void request("/recovery")
      .then(setRecovery)
      .catch(() => setRecovery({}));
  }, [refresh]);
  return (
    <>
      <form
        className={styles.panel}
        onSubmit={async (event) => {
          event.preventDefault();
          const result = await mutation.save("/backups", Object.fromEntries(new FormData(event.currentTarget)));
          if (result) setBackup(result);
        }}
      >
        <h3>{t("Verschlüsselte Firmensicherung", "Encrypted company backup")}</h3>
        <Field label={t("Installiertes age Programm (absoluter Pfad)", "Installed age executable (absolute path)")}>
          <input name="ageExecutable" placeholder="/usr/local/bin/age" required />
        </Field>
        <Field label={t("Öffentlicher age-Empfängerschlüssel", "Public age recipient key")}>
          <input name="recipient" placeholder="age1…" pattern="age1.+" required />
        </Field>
        <Field
          label={t("Sicherungsziel auf dem Server (absoluter Pfad)", "Backup destination on server (absolute path)")}
        >
          <input name="outputDirectory" required />
        </Field>
        <p className={styles.muted}>
          {t(
            "Die Sicherung pausiert neue Arbeit kurzzeitig für einen konsistenten Datenstand. Der private Entschlüsselungsschlüssel wird hier nicht eingegeben.",
            "Backup briefly pauses new work to capture consistent data. The private decryption key is not entered here.",
          )}
        </p>
        <button disabled={mutation.busy}>
          {mutation.busy
            ? t("Sicherung läuft…", "Backup in progress…")
            : t("Verschlüsselte Sicherung erstellen", "Create encrypted backup")}
        </button>
      </form>
      {backup && (
        <div className={styles.panel}>
          <h3>{t("Sicherungsarchiv erstellt", "Backup archive created")}</h3>
          <p className={styles.muted}>{str(backup, "archivePath")}</p>
          <p className={styles.json}>SHA-256: {str(backup, "sha256")}</p>
          <p>
            {t(
              "Archivprüfung durchgeführt. Eine Wiederherstellung auf einem frischen Ziel muss separat geprüft werden.",
              "Archive verification completed. Restore on a fresh target must be tested separately.",
            )}
          </p>
        </div>
      )}
      {recovery.dispatchPaused === true && (
        <form
          className={styles.panel}
          onSubmit={(e) => {
            e.preventDefault();
            void mutation.save("/recovery/resume", { reviewedExternalEffects: true });
          }}
        >
          <h3>{t("Kontrolliert wiederaufnehmen", "Resume in a controlled way")}</h3>
          <p>
            {t(
              "Automatische Arbeit ist nach Wiederherstellung pausiert. Noch ungeklärte Wirkungen oder Modellkosten verhindern die Wiederaufnahme.",
              "Automatic work is paused after recovery. Unreconciled effects or model costs prevent resumption.",
            )}
          </p>
          <label className={styles.check}>
            <input type="checkbox" required />
            {t(
              "Externe Wirkungen und ausstehende Automatik wurden geprüft.",
              "External effects and pending automation have been reviewed.",
            )}
          </label>
          <button disabled={mutation.busy}>{t("Nach Prüfung wiederaufnehmen", "Resume after review")}</button>
        </form>
      )}
      <Feedback state={mutation} locale={locale} />
    </>
  );
}
