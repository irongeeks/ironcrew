import { useId, Children, isValidElement, cloneElement } from "react";
import IntegrationCosts from "./IntegrationCosts.tsx";
import ModelCosts from "./ModelCosts.tsx";
import Entities, { entityScope } from "./Entities.tsx";
import SetupSteps from "./SetupSteps.tsx";
import SetupDraft from "./SetupDraft.tsx";
import {
  ConfigurationPanel,
  OrderWorkflow,
  SchedulePanel,
  MandatePanel,
  KnowledgePanel,
  BackupPanel,
} from "./Workflows.tsx";
import { Component, Suspense, lazy, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { ApiError, SESSION_EXPIRED_EVENT, list, money, request, string as str, type Row } from "./api.ts";
import styles from "./App.module.css";
import Finance from "./Finance.tsx";
import CommandPalette from "./CommandPalette.tsx";
import Notifications from "./Notifications.tsx";
import Channels from "./Channels.tsx";
import { Workers } from "./Operations.tsx";
import Maintenance from "./Maintenance.tsx";
const CrewPortrait = lazy(() => import("./CrewPortrait.tsx"));
const Hall = lazy(() => import("./Hall.tsx"));
type Locale = "de" | "en";
const labels: Record<string, [string, string]> = {
  hq: ["Hauptquartier", "Headquarters"],
  orders: ["Aufträge", "Orders"],
  crew: ["Crew", "Crew"],
  knowledge: ["Wissen", "Knowledge"],
  settings: ["Einstellungen", "Settings"],
  decisions: ["Entscheidungen", "Decisions"],
  finance: ["Finanzen", "Finance"],
  inbox: ["Eingang", "Inbox"],
  planning: ["Planung", "Planning"],
  ready: ["Bereit", "Ready"],
  running: ["In Arbeit", "Running"],
  reviewing: ["Prüfung", "Reviewing"],
  completed: ["Abgeschlossen", "Completed"],
  paused: ["Pausiert", "Paused"],
  blocked: ["Blockiert", "Blocked"],
  cancelled: ["Abgebrochen", "Cancelled"],
  failed: ["Fehlgeschlagen", "Failed"],
  approval: ["Freigabe erforderlich", "Approval required"],
  budget: ["Budget fehlt", "Budget required"],
  external: ["Externe Antwort", "External response"],
  worker: ["Worker nicht erreichbar", "Worker unavailable"],
  tool_error: ["Werkzeugfehler", "Tool error"],
  unknown_effect: ["Wirkung ungeklärt", "Effect unknown"],
  user_input: ["Rückfrage", "Question"],
  website: ["Website", "Website"],
  incident: ["IT-Störung", "IT incident"],
  research: ["Recherche", "Research"],
};
const txt = (key: string, locale: Locale) => labels[key]?.[locale === "de" ? 0 : 1] ?? key;
function useEventRevision() {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const refresh = () => setRevision((v) => v + 1);
    window.addEventListener("ironcrew:update", refresh);
    return () => window.removeEventListener("ironcrew:update", refresh);
  }, []);
  return revision;
}
function Link({
  to,
  children,
  ...props
}: {
  to: string;
  children: ReactNode;
  className?: string;
  "aria-current"?: "page";
}) {
  return (
    <a
      {...props}
      href={to}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey) return;
        event.preventDefault();
        history.pushState(null, "", to);
        window.dispatchEvent(new PopStateEvent("popstate"));
      }}
    >
      {children}
    </a>
  );
}
function useRoute() {
  const [url, setUrl] = useState(() => location.pathname + location.search);
  useEffect(() => {
    const fn = () => setUrl(location.pathname + location.search);
    window.addEventListener("popstate", fn);
    return () => window.removeEventListener("popstate", fn);
  }, []);
  return url;
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

function Empty({ children }: { children: ReactNode }) {
  return <div className={styles.empty}>{children}</div>;
}
function Status({ value, locale }: { value: string; locale: Locale }) {
  return (
    <span className={styles.status} data-status={value}>
      <span aria-hidden="true" /> {txt(value, locale)}
    </span>
  );
}
class GraphicsBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
function Setup({ locale, onReady, existing = false }: { locale: Locale; onReady: () => void; existing?: boolean }) {
  const [step, setStep] = useState(existing ? 1 : 0),
    [token, setToken] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [saved, setSaved] = useState<Row>({});
  const t = (de: string, en: string) => (locale === "de" ? de : en);
  useEffect(() => {
    if (existing)
      void request("/setup")
        .then((progress) => {
          setStep(Math.min(7, Number(progress.step ?? 1)));
          setSaved((progress.data ?? {}) as Row);
        })
        .catch((e) => setError(e.message));
  }, [existing]);
  const titles = [
    t("CEO & Firma", "CEO & company"),
    t("Deine Crew", "Your crew"),
    t("Modelle & Zugang", "Models & access"),
    t("Gemeinsames Budget", "Company budget"),
    t("Ausführungsrechner", "Workers"),
    t("Bereiche & Verbindungen", "Areas & connections"),
    t("Mandate & Routinen", "Mandates & schedules"),
    t("Bereit für dein Hauptquartier", "Ready for headquarters"),
  ];
  async function resume() {
    setBusy(true);
    try {
      const progress = await request("/setup", { token });
      setSaved((progress.data ?? {}) as Row);
      setStep(Number(progress.step ?? 0));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form));
    setBusy(true);
    setError("");
    try {
      if (step === 0) {
        await request("/setup", { method: "POST", body: { token, ...data } });
        setToken("");
        form.reset();
        delete data.password;
        await request("/setup", { method: "PATCH", body: { step: 1, data } });
      } else {
        if (step === 2 && data.modelPlan === "configured") {
          const config = await request("/configuration");
          if (!config.proton || !config.openrouter)
            throw new Error(
              t(
                "Modellzugang fehlt. Speichern oder ausdrücklich später einrichten.",
                "Model access missing. Save it or explicitly defer setup.",
              ),
            );
        }
        if (step === 4 && data.workerPlan === "configured") {
          const config = await request("/configuration"),
            workers = await list("/workers");
          if (
            !config.isolationProfilePath &&
            !config.remoteWorkerId &&
            !workers.some((worker) => worker.revoked !== true)
          )
            throw new Error(
              t(
                "Kein Ausführungspfad oder Worker-Enrollment gespeichert. Einrichten oder ausdrücklich später verbinden.",
                "No execution path or worker enrollment saved. Configure it or explicitly defer connection.",
              ),
            );
        }
        if (step === 3)
          await request("/budget", {
            method: "POST",
            body: {
              limitUsdMicros: String(Math.round(Number(data.budgetUsd) * 1e6)),
              startsAt: new Date(String(data.startsAt)).toISOString(),
              endsAt: new Date(String(data.endsAt)).toISOString(),
            },
          });
        await request("/setup", { method: "PATCH", body: { step: step + 1, data: { ...saved, ...data } } });
      }
      setSaved({ ...saved, ...data });
      if (step === 7) {
        onReady();
        history.replaceState(null, "", "/hq");
        window.dispatchEvent(new PopStateEvent("popstate"));
      } else setStep(step + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className={styles.setup}>
      <img src="/brand/emblem.png" className={styles.setupLogo} alt="Iron Geeks" />
      <div className={styles.setupPanel}>
        <p className={styles.eyebrow}>IRONCREW / {t("GRÜNDUNG", "FOUNDING")}</p>
        <h1>{titles[step] ?? titles[7]}</h1>
        <p>
          {t(
            "Deine digitale Firma. Schritt für Schritt eingerichtet.",
            "Your digital company. Set up one step at a time.",
          )}
        </p>
        <progress max={8} value={step + 1} aria-label={t("Einrichtungsfortschritt", "Setup progress")} />
        <p className={styles.muted}>{step + 1} / 8</p>
        {step === 0 && (
          <Field label={t("Einmaliges Setup-Token", "One-time setup token")}>
            <input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />
            <button type="button" className={styles.secondary} disabled={!token || busy} onClick={() => void resume()}>
              {t("Gespeicherten Stand laden", "Load saved progress")}
            </button>
          </Field>
        )}
        <SetupDraft step={step}>
          {step > 0 && step !== 3 && <SetupSteps key={`step-${step}`} step={step} locale={locale} />}
        </SetupDraft>
        <form
          id="setup-navigation"
          key={`navigation-${step}`}
          onSubmit={(event) => void submit(event)}
          onInvalid={() =>
            setError(
              t(
                "Bitte vervollständige die Pflichtangaben und Bestätigungen dieses Einrichtungsschritts.",
                "Please complete the required fields and confirmations for this setup step.",
              ),
            )
          }
        >
          {step === 0 && (
            <>
              <Field label={t("Dein Name", "Your name")}>
                <input name="ceoName" autoComplete="name" required defaultValue={str(saved, "ceoName")} />
              </Field>
              <Field label={t("Firmenname", "Company name")}>
                <input name="companyName" required defaultValue={str(saved, "companyName", "Iron Geeks")} />
              </Field>
              <Field label={t("Passwort (mindestens 12 Zeichen)", "Password (at least 12 characters)")}>
                <input name="password" type="password" autoComplete="new-password" minLength={12} required />
              </Field>
              <Field label={t("Sprache", "Language")}>
                <select name="locale" defaultValue={locale}>
                  <option value="de">Deutsch</option>
                  <option value="en">English</option>
                </select>
              </Field>
              <Field label={t("Zeitzone bestätigen", "Confirm timezone")}>
                <input
                  name="timezone"
                  placeholder="Europe/Berlin"
                  required
                  defaultValue={str(saved, "timezone", "Europe/Berlin")}
                />
              </Field>
            </>
          )}
          {step === 1 && (
            <label className={styles.check}>
              <input
                type="checkbox"
                name="crewAndBrandReviewed"
                required
                defaultChecked={saved.crewAndBrandReviewed === "on"}
              />
              {t("Crew und mitgelieferte Logos geprüft.", "Crew and supplied logos reviewed.")}
            </label>
          )}
          {step === 2 && (
            <Field label={t("Modellzugang fortsetzen", "Continue model setup")}>
              <select name="modelPlan" defaultValue={str(saved, "modelPlan", "")} required>
                <option value="">{t("Entscheidung auswählen", "Choose a decision")}</option>
                <option value="configured">
                  {t("Zugang gespeichert und Prüfung angesehen", "Access saved and check reviewed")}
                </option>
                <option value="later">
                  {t(
                    "Später einrichten — fehlender Zugang bleibt gesperrt",
                    "Configure later — missing access remains blocked",
                  )}
                </option>
              </select>
            </Field>
          )}
          {step === 3 && (
            <>
              <p>
                {t(
                  "Es gibt keine automatische kostenpflichtige Freigabe. 0 USD sperrt kostenpflichtige Aufrufe.",
                  "There is no automatic spending approval. USD 0 blocks paid calls.",
                )}
              </p>
              <Field label={t("Budgetlimit in USD", "Budget limit in USD")}>
                <input
                  name="budgetUsd"
                  type="number"
                  min="0"
                  step="0.01"
                  defaultValue={str(saved, "budgetUsd", "0")}
                  required
                />
              </Field>
              <Field label={t("Zeitraum von", "Period starts")}>
                <input type="date" name="startsAt" required defaultValue={str(saved, "startsAt")} />
              </Field>
              <Field label={t("Zeitraum bis", "Period ends")}>
                <input type="date" name="endsAt" required defaultValue={str(saved, "endsAt")} />
              </Field>
            </>
          )}
          {step === 4 && (
            <Field label={t("Ausführung fortsetzen", "Continue worker setup")}>
              <select name="workerPlan" defaultValue={str(saved, "workerPlan", "")} required>
                <option value="">{t("Entscheidung auswählen", "Choose a decision")}</option>
                <option value="configured">
                  {t(
                    "Ausführungspfad beziehungsweise Enrollment eingerichtet",
                    "Execution path or enrollment configured",
                  )}
                </option>
                <option value="later">
                  {t(
                    "Später verbinden — fehlende Ausführung bleibt gesperrt",
                    "Connect later — unavailable execution stays blocked",
                  )}
                </option>
              </select>
            </Field>
          )}
          {step === 5 && (
            <label className={styles.check}>
              <input
                type="checkbox"
                name="connectionsReviewed"
                required
                defaultChecked={saved.connectionsReviewed === "on"}
              />
              {t(
                "Gespeicherte Bereiche und Verbindungen geprüft; fehlende Zugänge richte ich später ein.",
                "Reviewed saved areas and connections; I will configure missing access later.",
              )}
            </label>
          )}
          {step === 6 && (
            <label className={styles.check}>
              <input
                type="checkbox"
                name="mandatesReviewed"
                required
                defaultChecked={saved.mandatesReviewed === "on"}
              />
              {t(
                "Konkrete Mandate und Routinen geprüft; fehlende Befugnisse bleiben gesperrt.",
                "Reviewed concrete mandates and schedules; missing authority remains blocked.",
              )}
            </label>
          )}
          {step === 7 && (
            <label className={styles.check}>
              <input type="checkbox" name="summaryReviewed" required />
              {t(
                "Den tatsächlichen Stand und die offenen Einrichtungspunkte geprüft.",
                "Reviewed actual state and remaining setup items.",
              )}
            </label>
          )}
          {error && (
            <p role="alert" className={styles.error}>
              {error}
            </p>
          )}
          <div className={styles.actions}>
            {step > 1 && (
              <button
                type="button"
                className={styles.secondary}
                onClick={() => {
                  const form = document.getElementById("setup-navigation") as HTMLFormElement;
                  setSaved((previous) => ({ ...previous, ...Object.fromEntries(new FormData(form)) }));
                  setStep(step - 1);
                }}
              >
                {t("Zurück", "Back")}
              </button>
            )}
            <button disabled={busy || (step === 0 && !token)}>
              {busy
                ? t("Wird gespeichert…", "Saving…")
                : step === 7
                  ? t("Hauptquartier öffnen", "Open headquarters")
                  : t("Speichern & weiter", "Save & continue")}
            </button>
          </div>
        </form>
      </div>
    </main>
  );
}
function Login({ onReady, locale }: { onReady: () => void; locale: Locale }) {
  const [error, setError] = useState("");
  return (
    <main className={styles.setup}>
      <img className={styles.setupLogo} src="/brand/emblem.png" alt="Iron Geeks" />
      <form
        className={styles.setupPanel}
        onSubmit={(e) => {
          e.preventDefault();
          const data = Object.fromEntries(new FormData(e.currentTarget));
          void request("/session", { method: "POST", body: data })
            .then(onReady)
            .catch((error) => setError(error.message));
        }}
      >
        <h1>IronCrew</h1>
        <Field label={locale === "de" ? "Passwort" : "Password"}>
          <input name="password" type="password" autoComplete="current-password" required />
        </Field>
        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
        <button>{locale === "de" ? "Anmelden" : "Sign in"}</button>
      </form>
    </main>
  );
}
export default function App() {
  const route = useRoute(),
    [locale, setLocale] = useState<Locale>(() => (localStorage.getItem("ironcrew.locale") === "en" ? "en" : "de")),
    [session, setSession] = useState<Row | null>(null),
    [error, setError] = useState(""),
    [online, setOnline] = useState(navigator.onLine),
    [search, setSearch] = useState(""),
    [revision, setRevision] = useState(0);
  const t = (de: string, en: string) => (locale === "de" ? de : en);
  const reload = () => setRevision((v) => v + 1);
  useEffect(() => {
    const expired = () => {
      setSession({ authenticated: false, setupRequired: false });
      setError("");
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, expired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, expired);
  }, []);
  useEffect(() => {
    document.documentElement.lang = locale;
    localStorage.setItem("ironcrew.locale", locale);
  }, [locale]);
  useEffect(() => {
    void request("/session")
      .then(async (value) => {
        if (value.authenticated) {
          const progress = await request("/setup");
          value.setupIncomplete = Number(progress.step ?? 1) < 8;
        }
        setSession(value);
      })
      .catch((e) => setError(e.message));
  }, [revision]);
  useEffect(() => {
    const on = () => setOnline(true),
      off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  if (!session)
    return (
      <main className={styles.setup}>
        <div className={styles.setupPanel}>
          <h1>IronCrew</h1>
          {error ? (
            <>
              <p role="alert" className={styles.error}>
                {error}
              </p>
              <button onClick={reload}>{t("Erneut versuchen", "Try again")}</button>
            </>
          ) : (
            <div className={styles.skeleton} aria-label={t("Wird geladen", "Loading")} />
          )}
        </div>
      </main>
    );
  if (session.setupRequired) return <Setup locale={locale} onReady={reload} />;
  if (session.authenticated && session.setupIncomplete) return <Setup locale={locale} existing onReady={reload} />;
  if (!session.authenticated) return <Login locale={locale} onReady={reload} />;
  const section = route.split("/")[1]?.split("?")[0] || "hq";
  return (
    <div className={styles.app}>
      <a className={styles.skip} href="#main">
        {t("Zum Inhalt", "Skip to content")}
      </a>
      <aside className={styles.sidebar}>
        <Link to="/hq">
          <img src="/brand/wordmark.png" alt="Iron Geeks" />
        </Link>
        <p className={styles.eyebrow}>IRONCREW</p>
        <nav aria-label={t("Hauptnavigation", "Main navigation")}>
          {["hq", "orders", "crew", "knowledge", "settings"].map((key, index) => (
            <Link key={key} to={`/${key}`} aria-current={section === key ? "page" : undefined}>
              <span aria-hidden="true" className={styles.navMark}>
                {["⌂", "▤", "◇", "▧", "⚙"][index]}
              </span>
              {txt(key, locale)}
            </Link>
          ))}
        </nav>
        <div className={styles.subnav}>
          <Link to="/decisions">{txt("decisions", locale)}</Link>
          <Link to="/finance">{txt("finance", locale)}</Link>
        </div>
        <div className={styles.sidebarFoot}>
          {t("Deine Firma. Deine Entscheidungen.", "Your company. Your decisions.")}
          <span className={styles.muted}>LOCAL FIRST / 0.4</span>
        </div>
      </aside>
      <div className={styles.body}>
        <header className={styles.topbar}>
          <div>
            <span className={styles.eyebrow}>IRON GEEKS</span>
            <span className={styles.divider}>/</span>
            {txt(section, locale)}
          </div>
          <div className={styles.topTools}>
            <CommandPalette locale={locale} />
            <Notifications locale={locale} />
            <label className={styles.search}>
              <span className={styles.srOnly}>{t("Aufträge suchen", "Search orders")}</span>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t("Auftrag suchen…", "Search orders…")}
              />
            </label>
            <select
              aria-label={t("Sprache", "Language")}
              value={locale}
              onChange={(e) => setLocale(e.target.value as Locale)}
            >
              <option value="de">DE</option>
              <option value="en">EN</option>
            </select>
            <details className={styles.account}>
              <summary>CEO</summary>
              <button
                className={styles.secondary}
                onClick={() => {
                  void request("/session", { method: "DELETE", body: {} })
                    .then(reload)
                    .catch((error: unknown) => {
                      if (error instanceof ApiError && error.status === 401) {
                        // Another request may already have expired this session and
                        // the user may have signed in again while logout was pending.
                        reload();
                      } else setError(error instanceof Error ? error.message : String(error));
                    });
                }}
              >
                {t("Abmelden", "Sign out")}
              </button>
            </details>
          </div>
        </header>
        {!online && (
          <p className={styles.warning} role="status">
            {t(
              "Offline · Änderungen können momentan nicht gespeichert werden.",
              "Offline · Changes cannot be saved at the moment.",
            )}
          </p>
        )}
        <main id="main" className={styles.main}>
          {section === "setup" ? (
            <Setup locale={locale} existing onReady={reload} />
          ) : (
            <Workspace key={section === "orders" ? "orders" : section} route={route} locale={locale} search={search} />
          )}
        </main>
      </div>
    </div>
  );
}
function Workspace({ route, locale, search }: { route: string; locale: Locale; search: string }) {
  const [data, setData] = useState<Record<string, Row[]>>({}),
    [company, setCompany] = useState<Row>({}),
    [budget, setBudget] = useState<Row>({}),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [stamp, setStamp] = useState(""),
    [show3d, setShow3d] = useState(() => innerWidth >= 768),
    [newOrder, setNewOrder] = useState(false),
    [board, setBoard] = useState(false),
    [filter, setFilter] = useState(""),
    [leadFilter, setLeadFilter] = useState(""),
    [areaFilter, setAreaFilter] = useState(""),
    [refresh, setRefresh] = useState(0);
  const t = (de: string, en: string) => (locale === "de" ? de : en);
  const section = route.split("/")[1]?.split("?")[0] || "hq",
    id = route.split("/")[2]?.split("?")[0];
  const reload = () => setRefresh((v) => v + 1);
  useEffect(() => {
    let active = true;
    setLoading(true);
    const names = ["employees", "areas", "orders", "approvals", "workers", "integrations"];
    void Promise.all([request("/company"), request("/budget"), ...names.map((name) => list(`/${name}`))])
      .then((result) => {
        if (!active) return;
        setCompany(result[0] as Row);
        setBudget(result[1] as Row);
        setData(Object.fromEntries(names.map((name, index) => [name, result[index + 2] as Row[]])));
        setStamp(new Date().toLocaleTimeString(locale));
        setError("");
      })
      .catch((e) => active && setError(e.message))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [refresh, locale]);
  useEffect(() => {
    const events = new EventSource("/api/v1/events", { withCredentials: true });
    let timer: number | undefined;
    const update = () => {
      if (timer !== undefined) return;
      timer = window.setTimeout(() => {
        timer = undefined;
        setRefresh((v) => v + 1);
        window.dispatchEvent(new Event("ironcrew:update"));
      }, 80);
    };
    events.onmessage = update;
    events.addEventListener("update", update);
    events.addEventListener("stale", () =>
      setError(locale === "de" ? "Ereignisstand veraltet. Bitte neu laden." : "Event stream is stale. Please reload."),
    );
    events.addEventListener("snapshot_required", update);
    return () => {
      events.close();
      window.clearTimeout(timer);
    };
  }, []);
  const crew = data.employees ?? [],
    orders = (data.orders ?? []).filter((order) =>
      str(order, "goal").toLocaleLowerCase().includes(search.toLocaleLowerCase()),
    ),
    approvals = data.approvals ?? [];
  const findLead = (order: Row) => crew.find((person) => person.id === order.leadEmployeeId);
  const cards = (rows: Row[]) =>
    rows.map((order) => (
      <Link key={str(order, "id")} className={styles.orderCard} to={`/orders/${str(order, "id")}`}>
        <span className={styles.eyebrow}>{txt(str(order, "kind"), locale)}</span>
        <h3>{str(order, "goal")}</h3>
        <Status value={str(order, "status")} locale={locale} />
        <p>
          {str(findLead(order) ?? {}, "displayName")} · {money(order.budgetLimitUsdMicros, locale)}
        </p>
        {Boolean(order.waitReason) && <p className={styles.warningText}>{txt(str(order, "waitReason"), locale)}</p>}
      </Link>
    ));
  if (loading && !stamp)
    return <div className={styles.skeleton} aria-label={t("Arbeitsstand wird geladen", "Loading workspace")} />;
  return (
    <>
      {error && (
        <div className={styles.error} role="alert">
          {stamp ? t("Stand möglicherweise veraltet. ", "Data may be stale. ") : ""}
          {error}{" "}
          <button className={styles.secondary} onClick={reload}>
            {t("Erneut laden", "Retry")}
          </button>
        </div>
      )}
      {section === "hq" && (
        <>
          <div className={styles.pageHeading}>
            <div>
              <p className={styles.eyebrow}>
                {str(company, "name", str(company, "companyName", "IRON GEEKS"))} /{" "}
                {t("EINSATZZENTRALE", "COMMAND CENTER")}
              </p>
              <h1>{t("Alles im Blick.", "Everything in view.")}</h1>
            </div>
            <span className={styles.muted}>
              {t("Datenstand", "Updated")} {stamp}
            </span>
          </div>
          <div className={styles.hqGrid}>
            <section className={styles.hallPanel}>
              <div className={styles.panelHeader}>
                <h2>{t("Deine Crew im Hauptquartier", "Your crew at headquarters")}</h2>
                <button className={styles.secondary} onClick={() => setShow3d((v) => !v)}>
                  {show3d ? t("Kompakte Ansicht", "Compact view") : "3D"}
                </button>
              </div>
              {show3d ? (
                <GraphicsBoundary
                  fallback={
                    <Empty>
                      {t(
                        "3D nicht verfügbar. Crew und Aufträge bleiben unten bedienbar.",
                        "3D unavailable. Crew and orders remain accessible below.",
                      )}
                    </Empty>
                  }
                >
                  <Suspense fallback={<div className={styles.skeleton} />}>
                    <Hall
                      employees={crew}
                      orders={data.orders ?? []}
                      onEmployee={(employeeId) => {
                        history.pushState(null, "", `/crew/${employeeId}`);
                        dispatchEvent(new PopStateEvent("popstate"));
                      }}
                      onOrder={(orderId) => {
                        history.pushState(null, "", `/orders/${orderId}`);
                        dispatchEvent(new PopStateEvent("popstate"));
                      }}
                      locale={locale}
                    />
                  </Suspense>
                </GraphicsBoundary>
              ) : (
                <div className={styles.compactHall}>
                  <img src="/brand/emblem.png" alt="Iron Geeks" />
                  <div>
                    <h2>{t("Starke Crew. Klare Verantwortung.", "A strong crew. Clear responsibility.")}</h2>
                    <p>
                      {t(
                        "Alle Arbeitsstände direkt erreichbar – auch ohne 3D.",
                        "Every work state directly accessible, including without 3D.",
                      )}
                    </p>
                  </div>
                </div>
              )}
              <div className={styles.crewStrip}>
                {crew.map((person) => (
                  <Link to={`/crew/${str(person, "id")}`} key={str(person, "id")}>
                    <span className={styles.monogram}>
                      {str(person, "displayName")
                        .split(" ")
                        .map((s) => s[0])
                        .slice(0, 2)
                        .join("")}
                    </span>
                    <span>{str(person, "displayName")}</span>
                  </Link>
                ))}
              </div>
            </section>
            <aside className={styles.briefing}>
              <p className={styles.eyebrow}>CERSEI / CHIEF OF STAFF</p>
              <h2>{t("Dein Briefing", "Your briefing")}</h2>
              <p>
                {approvals.length
                  ? t(
                      `${approvals.length} Entscheidungen warten auf dich.`,
                      `${approvals.length} decisions need your attention.`,
                    )
                  : t("Im Moment wartet keine Entscheidung auf dich.", "No decisions are waiting for you.")}
              </p>
              <Link className={styles.primaryLink} to="/hq?chat=ceo">
                {t("Mit Cersei sprechen", "Talk to Cersei")}
                <span aria-hidden="true">→</span>
              </Link>
              <Link className={styles.metric} to="/decisions">
                <strong>
                  {approvals.filter((a) => !["approved", "denied", "expired"].includes(str(a, "status"))).length}
                </strong>
                {txt("decisions", locale)}
              </Link>
              <Link className={styles.metric} to="/orders">
                <strong>{orders.filter((o) => !["completed", "cancelled"].includes(str(o, "status"))).length}</strong>
                {t("aktive Aufträge", "active orders")}
              </Link>
              <Budget value={budget} locale={locale} />
            </aside>
          </div>
          {route.includes("chat=ceo") && (
            <section className={styles.panel}>
              <div className={styles.panelHeader}>
                <h2>{t("Dein Gespräch mit Cersei", "Your conversation with Cersei")}</h2>
                <Link to="/hq">{t("Schließen", "Close")}</Link>
              </div>
              <Chat path="/company/messages" locale={locale} />
            </section>
          )}
          <div className={styles.sectionHeading}>
            <h2>{t("Aktuelle Aufträge", "Current orders")}</h2>
            <Link to="/orders">{t("Alle Aufträge ansehen", "View all orders")} →</Link>
          </div>
          <div className={styles.orderGrid}>{cards(orders.slice(0, 6))}</div>
          {!orders.length && (
            <Empty>
              <h3>{t("Platz für deinen ersten Auftrag.", "Room for your first order.")}</h3>
              <p>
                {t(
                  "Beschreibe das Ziel. Weise Verantwortung und Budget bewusst zu.",
                  "Describe the goal. Assign responsibility and budget explicitly.",
                )}
              </p>
              <button onClick={() => setNewOrder(true)}>{t("Neuen Auftrag anlegen", "Create an order")}</button>
            </Empty>
          )}
        </>
      )}
      {section === "orders" && !id && (
        <>
          <div className={styles.pageHeading}>
            <div>
              <p className={styles.eyebrow}>IRONCREW / {t("ARBEIT", "WORK")}</p>
              <h1>{txt("orders", locale)}</h1>
            </div>
            <button onClick={() => setNewOrder(true)}>{t("Neuer Auftrag", "New order")}</button>
          </div>
          <div className={styles.toolbar}>
            <Field label={t("Status", "Status")}>
              <select value={filter} onChange={(e) => setFilter(e.target.value)}>
                <option value="">{t("Alle Zustände", "All statuses")}</option>
                {Object.keys(labels)
                  .filter((key) =>
                    [
                      "inbox",
                      "planning",
                      "ready",
                      "running",
                      "reviewing",
                      "completed",
                      "paused",
                      "blocked",
                      "cancelled",
                      "failed",
                    ].includes(key),
                  )
                  .map((key) => (
                    <option value={key} key={key}>
                      {txt(key, locale)}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="Lead">
              <select value={leadFilter} onChange={(e) => setLeadFilter(e.target.value)}>
                <option value="">{t("Alle Leads", "All leads")}</option>
                {crew.map((p) => (
                  <option key={str(p, "id")} value={str(p, "id")}>
                    {str(p, "displayName")}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t("Bereich", "Area")}>
              <select value={areaFilter} onChange={(e) => setAreaFilter(e.target.value)}>
                <option value="">{t("Alle Bereiche", "All areas")}</option>
                {(data.areas ?? []).map((a) => (
                  <option key={str(a, "id")} value={str(a, "id")}>
                    {str(a, "name")}
                  </option>
                ))}
              </select>
            </Field>
            <button className={styles.secondary} onClick={() => setBoard((v) => !v)} aria-pressed={board}>
              {board ? t("Listenansicht", "List view") : "Kanban"}
            </button>
          </div>
          {board ? (
            <div className={styles.board}>
              {["inbox", "planning", "ready", "running", "reviewing", "blocked", "completed"].map((status) => (
                <section key={status}>
                  <h2>{txt(status, locale)}</h2>
                  {cards(
                    orders.filter(
                      (o) =>
                        o.status === status &&
                        (!filter || o.status === filter) &&
                        (!leadFilter || o.leadEmployeeId === leadFilter) &&
                        (!areaFilter || (o.scope as Row)?.areaId === areaFilter),
                    ),
                  )}
                </section>
              ))}
            </div>
          ) : (
            <div className={styles.orderGrid}>
              {cards(
                orders.filter(
                  (o) =>
                    (!filter || o.status === filter) &&
                    (!leadFilter || o.leadEmployeeId === leadFilter) &&
                    (!areaFilter || (o.scope as Row)?.areaId === areaFilter),
                ),
              )}
            </div>
          )}
          {!orders.length && (
            <Empty>
              {t("Noch keine Aufträge. Lege deinen ersten Auftrag an.", "No orders yet. Create your first order.")}
            </Empty>
          )}
        </>
      )}
      {section === "orders" && id && (
        <OrderDetail id={id} route={route} crew={crew} locale={locale} onChange={reload} />
      )}
      {section === "crew" && (
        <>
          <div className={styles.pageHeading}>
            <div>
              <p className={styles.eyebrow}>{t("NEUN PERSPEKTIVEN / EIN TEAM", "NINE PERSPECTIVES / ONE TEAM")}</p>
              <h1>{t("Deine Crew", "Your crew")}</h1>
            </div>
          </div>
          <div className={styles.profileGrid}>
            {crew
              .filter((person) => !id || person.id === id)
              .map((person) => (
                <CrewProfile
                  key={str(person, "id")}
                  person={person}
                  locale={locale}
                  editable={Boolean(id)}
                  onChange={reload}
                />
              ))}
          </div>
        </>
      )}
      {section === "decisions" && (
        <>
          <h1>{txt("decisions", locale)}</h1>
          <p>
            {t(
              "Jede Freigabe gilt für genau diese Aktion, Version und Argumente.",
              "Each approval binds to this exact action, version and arguments.",
            )}
          </p>
          {approvals.length ? (
            approvals.map((a) => <Decision key={str(a, "id")} approval={a} locale={locale} onChange={reload} />)
          ) : (
            <Empty>{t("Keine offenen Entscheidungen.", "No pending decisions.")}</Empty>
          )}
        </>
      )}
      {section === "finance" && (
        <>
          <h1>{txt("finance", locale)}</h1>
          <Budget value={budget} locale={locale} />
          <Finance locale={locale} areas={data.areas ?? []} />
        </>
      )}
      {section === "knowledge" && (
        <>
          <h1>{txt("knowledge", locale)}</h1>
          <p>
            {t(
              "Quellen, geprüfte Versionen und Vorschläge. Fachwissen wird vom Lead geprüft; Firmenregeln entscheidest du.",
              "Sources, reviewed versions and proposals. Leads review specialist knowledge; you decide company rules.",
            )}
          </p>
          <KnowledgePanel crew={crew} locale={locale} />
        </>
      )}
      {section === "settings" && (
        <Settings section={id ?? "company"} company={company} crew={crew} locale={locale} onChange={reload} />
      )}
      {newOrder && (
        <NewOrder
          company={company}
          crew={crew}
          areas={data.areas ?? []}
          locale={locale}
          onClose={() => setNewOrder(false)}
          onCreated={() => {
            setNewOrder(false);
            reload();
          }}
        />
      )}
    </>
  );
}
function Budget({ value, locale }: { value: Row; locale: Locale }) {
  const t = (de: string, en: string) => (locale === "de" ? de : en);
  return (
    <section className={styles.budget}>
      <h3>{t("Gemeinsamer Firmentopf", "Company budget")}</h3>
      <p className={styles.muted}>
        {str(value, "startsAt", str(value, "periodStart", "—"))} – {str(value, "endsAt", str(value, "periodEnd", "—"))}
      </p>
      <dl>
        {[
          ["spentUsdMicros", t("Verbraucht", "Consumed")],
          ["reservedUsdMicros", t("Reserviert", "Reserved")],
          ["availableUsdMicros", t("Verfügbar", "Available")],
        ].map(([key, label]) => (
          <div key={key}>
            <dt>{label}</dt>
            <dd>{money(value[key], locale)}</dd>
          </div>
        ))}
      </dl>
      {value.unreconciledCount !== undefined && (
        <p>
          {t("Ungeklärte Abrechnungen", "Unreconciled charges")}: {String(value.unreconciledCount)}
        </p>
      )}
    </section>
  );
}
function NewOrder({
  company,
  crew,
  areas,
  locale,
  onClose,
  onCreated,
}: {
  company: Row;
  crew: Row[];
  areas: Row[];
  locale: Locale;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [scopeLoading, setScopeLoading] = useState(true),
    [customers, setCustomers] = useState<Row[]>([]),
    [projects, setProjects] = useState<Row[]>([]),
    [areaId, setAreaId] = useState(str(areas[0] ?? {}, "id")),
    [customerId, setCustomerId] = useState(""),
    [projectId, setProjectId] = useState("");
  const t = (de: string, en: string) => (locale === "de" ? de : en);
  useEffect(() => {
    let alive = true;
    void Promise.all([list("/customers"), list("/projects")])
      .then(([c, p]) => {
        if (alive) {
          setCustomers(c);
          setProjects(p);
          setScopeLoading(false);
        }
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    const dialog = document.querySelector("dialog");
    dialog?.showModal();
    return () => previous?.focus();
  }, []);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    const f = new FormData(e.currentTarget);
    try {
      await request("/orders", {
        method: "POST",
        body: {
          goal: f.get("goal"),
          kind: f.get("kind"),
          scope: {
            companyId: company.id,
            areaId,
            ...(customerId ? { customerId } : {}),
            ...(projectId ? { projectId } : {}),
          },
          leadEmployeeId: f.get("leadEmployeeId"),
          budgetLimitUsdMicros: String(Math.round(Number(f.get("budget")) * 1e6)),
          acceptanceCriteria: String(f.get("criteria")).split("\n").filter(Boolean),
        },
      });
      onCreated();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog className={styles.dialog} onCancel={onClose}>
      <form onSubmit={(e) => void submit(e)}>
        <div className={styles.panelHeader}>
          <h2>{t("Neuer Auftrag", "New order")}</h2>
          <button type="button" className={styles.secondary} onClick={onClose}>
            {t("Schließen", "Close")}
          </button>
        </div>
        <Field label={t("Ziel & gewünschtes Ergebnis", "Goal & desired result")}>
          <textarea name="goal" autoFocus required rows={3} />
        </Field>
        <Field label={t("Ablauf", "Workflow")}>
          <select name="kind">
            {["website", "incident", "finance", "research"].map((k) => (
              <option key={k} value={k}>
                {txt(k, locale)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Lead">
          <select required name="leadEmployeeId">
            {crew.map((p) => (
              <option key={str(p, "id")} value={str(p, "id")}>
                {str(p, "displayName")} · {str(p, "role")}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("Bereich", "Area")}>
          <select
            name="areaId"
            required
            value={areaId}
            onChange={(e) => {
              setAreaId(e.target.value);
              setCustomerId("");
              setProjectId("");
            }}
          >
            {areas.map((a) => (
              <option key={str(a, "id")} value={str(a, "id")}>
                {str(a, "name")}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("Kunde (optional)", "Customer (optional)")}>
          <select
            value={customerId}
            disabled={scopeLoading}
            onChange={(e) => {
              setCustomerId(e.target.value);
              setProjectId("");
            }}
          >
            <option value="">{t("Ohne Kunde / intern", "No customer / internal")}</option>
            {customers
              .filter((c) => entityScope(c).areaId === areaId)
              .map((c) => (
                <option key={str(c, "id")} value={str(c, "id")}>
                  {str(c, "name")}
                </option>
              ))}
          </select>
        </Field>
        <Field label={t("Projekt (optional)", "Project (optional)")}>
          <select value={projectId} disabled={scopeLoading} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">{t("Ohne Projekt", "No project")}</option>
            {projects
              .filter((p) => entityScope(p).areaId === areaId && (entityScope(p).customerId ?? "") === customerId)
              .map((p) => (
                <option key={str(p, "id")} value={str(p, "id")}>
                  {str(p, "name")}
                </option>
              ))}
          </select>
        </Field>
        <Field label={t("Kostenrahmen (USD)", "Budget limit (USD)")}>
          <input name="budget" type="number" min="0" step="0.01" defaultValue="0" required />
        </Field>
        <Field label={t("Abnahmekriterien (eins je Zeile)", "Acceptance criteria (one per line)")}>
          <textarea name="criteria" required rows={3} />
        </Field>
        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
        <button disabled={busy || scopeLoading || !areas.length || !crew.length}>
          {busy ? t("Wird angelegt…", "Creating…") : t("Auftrag anlegen", "Create order")}
        </button>
      </form>
    </dialog>
  );
}
function Chat({ path, locale, websiteFeedback = false }: { path: string; locale: Locale; websiteFeedback?: boolean }) {
  const eventRevision = useEventRevision();
  const [messages, setMessages] = useState<Row[]>([]),
    [asChange, setAsChange] = useState(false),
    [text, setText] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const t = (de: string, en: string) => (locale === "de" ? de : en);
  useEffect(() => {
    let alive = true;
    void list(path)
      .then((rows) => alive && setMessages(rows))
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [path, eventRevision]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      if (websiteFeedback && asChange) {
        const base = path.replace(/\/messages$/, ""),
          workflow = await request(`${base}/workflow`);
        const artifactVersionId = str(workflow, "artifactVersionId");
        if (!artifactVersionId)
          throw new Error(
            t(
              "Noch kein Website-Artefakt vorhanden. Änderungswünsche benötigen eine konkrete Vorschauversion.",
              "No website artifact exists yet. Change requests need a specific preview version.",
            ),
          );
        await request(`${base}/website/pins`, {
          method: "POST",
          body: {
            artifactVersionId,
            viewport: { width: 1440, height: 650 },
            anchor: "general",
            comment: text,
            source: "chat",
            deferDispatch: false,
          },
        });
      } else await request(path, { method: "POST", body: { content: text } });
      setText("");
      setMessages(await list(path));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={styles.chat}>
      <div className={styles.messages} aria-live="polite">
        {messages.length ? (
          messages.map((message) => (
            <article key={str(message, "id")} className={styles.message}>
              <div className={styles.muted}>
                {str(message, "role", str(message, "sender", "Crew"))} · {str(message, "createdAt")}
              </div>
              <p>{str(message, "content")}</p>
            </article>
          ))
        ) : (
          <p className={styles.muted}>
            {t("Das Gespräch bleibt bei diesem Auftrag gespeichert.", "This conversation is saved with the order.")}
          </p>
        )}
      </div>
      <form onSubmit={(e) => void submit(e)}>
        <Field label={t("Nachricht", "Message")}>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={3}
            required
            placeholder={t("Ziel, Rückfrage oder Feedback…", "Goal, question or feedback…")}
          />
        </Field>
        {websiteFeedback && (
          <label className={styles.check}>
            <input type="checkbox" checked={asChange} onChange={(event) => setAsChange(event.target.checked)} />
            {t("Als Änderungswunsch erfassen", "Record as change request")}
          </label>
        )}
        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
        <button disabled={busy || !text.trim()}>{busy ? t("Wird gesendet…", "Sending…") : t("Senden", "Send")}</button>
      </form>
    </div>
  );
}
function OrderDetail({
  id,
  route,
  crew,
  locale,
  onChange,
}: {
  id: string;
  route: string;
  crew: Row[];
  locale: Locale;
  onChange: () => void;
}) {
  const eventRevision = useEventRevision();
  const [order, setOrder] = useState<Row | null>(null),
    [error, setError] = useState(""),
    [revision, setRevision] = useState(0),
    [mobile, setMobile] = useState("project"),
    [split, setSplit] = useState(32);
  const t = (de: string, en: string) => (locale === "de" ? de : en);
  const tab = new URLSearchParams(route.split("?")[1]).get("tab") ?? "overview";
  useEffect(() => {
    void request(`/orders/${id}`)
      .then(setOrder)
      .catch((e) => setError(e.message));
  }, [id, revision, eventRevision]);
  async function transition(status: string) {
    try {
      await request(`/orders/${id}/transition`, { method: "POST", body: { status }, revision: order?.revision });
      setRevision((v) => v + 1);
      onChange();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <>
      <Link to="/orders">← {t("Alle Aufträge", "All orders")}</Link>
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {!order ? (
        <div className={styles.skeleton} />
      ) : (
        <>
          <div className={styles.pageHeading}>
            <div>
              <p className={styles.eyebrow}>
                {txt(str(order, "kind"), locale)} / {t("PLANVERSION", "PLAN VERSION")} {String(order.planVersion)}
              </p>
              <h1>{str(order, "goal")}</h1>
              <p>
                Lead: {str(crew.find((p) => p.id === order.leadEmployeeId) ?? {}, "displayName")} ·{" "}
                {money(order.budgetLimitUsdMicros, locale)}
              </p>
              <Status value={str(order, "status")} locale={locale} />
              {Boolean(order.waitReason) && (
                <p className={styles.warningText}>{txt(str(order, "waitReason"), locale)}</p>
              )}
            </div>
            <div className={styles.actions}>
              {!["completed", "cancelled", "failed"].includes(str(order, "status")) && (
                <>
                  <button
                    className={styles.secondary}
                    onClick={() => void transition(order.status === "paused" ? "ready" : "paused")}
                  >
                    {order.status === "paused" ? t("Fortsetzen", "Resume") : t("Pausieren", "Pause")}
                  </button>
                  <button className={styles.secondary} onClick={() => void transition("cancelled")}>
                    {t("Abbrechen", "Cancel")}
                  </button>
                </>
              )}
            </div>
          </div>
          <div className={styles.mobileTabs}>
            <button aria-pressed={mobile === "chat"} onClick={() => setMobile("chat")}>
              Chat
            </button>
            <button aria-pressed={mobile === "project"} onClick={() => setMobile("project")}>
              {t("Arbeitsfläche", "Workspace")}
            </button>
          </div>
          <div className={styles.split} style={{ "--chat-width": `${split}%` } as React.CSSProperties}>
            <section className={styles.chatSide} data-mobile-active={mobile === "chat"}>
              <h2>Chat</h2>
              <Chat
                key={id}
                path={`/orders/${id}/messages`}
                locale={locale}
                websiteFeedback={order.kind === "website"}
              />
            </section>
            <div className={styles.resize}>
              <label>
                <span className={styles.srOnly}>{t("Chatbreite", "Chat width")}</span>
                <input
                  type="range"
                  min={25}
                  max={50}
                  value={split}
                  onChange={(e) => setSplit(Number(e.target.value))}
                  aria-label={t("Chatbreite", "Chat width")}
                />
              </label>
            </div>
            <section className={styles.projectSide} data-mobile-active={mobile === "project"}>
              <nav className={styles.tabs} aria-label={t("Auftragsansichten", "Order views")}>
                {[
                  ["overview", t("Überblick", "Overview")],
                  ["result", t("Ergebnis", "Result")],
                  ["history", t("Verlauf", "History")],
                  ["files", t("Dateien", "Files")],
                  ["reviews", t("Prüfungen", "Reviews")],
                ].map(([key, label]) => (
                  <Link key={key} to={`/orders/${id}?tab=${key}`} aria-current={tab === key ? "page" : undefined}>
                    {label}
                  </Link>
                ))}
              </nav>
              {tab === "overview" ? (
                <>
                  <h2>{t("Ergebnis & Abnahme", "Result & acceptance")}</h2>
                  <ul>
                    {(Array.isArray(order.acceptanceCriteria) ? order.acceptanceCriteria : []).map((criterion, i) => (
                      <li key={i}>{String(criterion)}</li>
                    ))}
                  </ul>
                  <Workflow kind={str(order, "kind")} locale={locale} />
                  <OrderWorkflow
                    order={order}
                    crew={crew}
                    locale={locale}
                    onChange={() => {
                      setRevision((v) => v + 1);
                      onChange();
                    }}
                  />
                  <p className={styles.muted}>
                    {t(
                      "Fortschritt wird aus belegten Arbeitsschritten abgeleitet. Ein angenommener Befehl ist noch kein Ergebnis.",
                      "Progress comes from evidenced work steps. An accepted command is not yet a result.",
                    )}
                  </p>
                </>
              ) : (
                <Resource
                  key={tab}
                  path={`/orders/${id}/${tab === "reviews" ? "reviews" : tab === "history" ? "events" : "artifacts"}`}
                  locale={locale}
                  title={tab === "result" ? t("Versionierte Ergebnisse", "Versioned results") : undefined}
                />
              )}
            </section>
          </div>
        </>
      )}
    </>
  );
}
function Workflow({ kind, locale }: { kind: string; locale: Locale }) {
  const map: Record<string, [string, string][]> = {
    website: [
      ["Briefing", "Briefing"],
      ["Konzepte", "Concepts"],
      ["Auswahl", "Selection"],
      ["Umsetzung", "Implementation"],
      ["Prüfung", "Review"],
      ["Abnahme", "Acceptance"],
      ["Veröffentlichung", "Publication"],
    ],
    incident: [
      ["Beobachtung", "Observation"],
      ["Diagnose", "Diagnosis"],
      ["Aktion", "Action"],
      ["Funktionsprüfung", "Verification"],
      ["Beobachtungsphase", "Monitoring"],
    ],
    finance: [
      ["Beleg", "Document"],
      ["Zuordnung", "Classification"],
      ["Prüfung", "Review"],
      ["Übergabe", "Delivery"],
    ],
    research: [
      ["Frage", "Question"],
      ["Quellen", "Sources"],
      ["Vergleich", "Comparison"],
      ["Empfehlung", "Recommendation"],
      ["Ergebnisdokument", "Document"],
    ],
  };
  return (
    <ol className={styles.workflow}>
      {(map[kind] ?? []).map(([de, en]) => (
        <li key={en}>{locale === "de" ? de : en}</li>
      ))}
    </ol>
  );
}
function CrewProfile({
  person,
  locale,
  editable,
  onChange,
}: {
  person: Row;
  locale: Locale;
  editable: boolean;
  onChange: () => void;
}) {
  const [error, setError] = useState(""),
    [saved, setSaved] = useState(false);
  const t = (de: string, en: string) => (locale === "de" ? de : en);
  return (
    <article className={styles.profile}>
      <div className={styles.profileHeader}>
        <Suspense fallback={null}>
          <CrewPortrait person={person} />
        </Suspense>
        <span className={styles.monogram}>
          {str(person, "displayName")
            .split(" ")
            .map((s) => s[0])
            .slice(0, 2)
            .join("")}
        </span>
        <div>
          <p className={styles.eyebrow}>{str(person, "role")}</p>
          <h2>{str(person, "displayName")}</h2>
        </div>
      </div>
      {editable ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const values = Object.fromEntries(new FormData(event.currentTarget));
            void request(`/employees/${str(person, "id")}`, {
              method: "PATCH",
              body: { ...values, modelOverride: values.modelOverride || null },
              revision: person.revision,
            })
              .then(() => {
                setSaved(true);
                setError("");
                onChange();
              })
              .catch((e) => setError(e.message));
          }}
        >
          {[
            ["displayName", t("Name", "Name")],
            ["persona", t("Umgangston & Persona", "Personality")],
            ["appearance", t("Erscheinung", "Appearance")],
            ["modelOverride", t("Festes Modell (optional)", "Fixed model (optional)")],
          ].map(([key, label]) => (
            <Field key={key} label={label}>
              {["persona", "appearance"].includes(key) ? (
                <textarea rows={3} name={key} defaultValue={str(person, key)} />
              ) : (
                <input name={key} defaultValue={str(person, key)} required={key === "displayName"} />
              )}
            </Field>
          ))}
          <p className={styles.muted}>
            {t(
              "Persona und Erscheinung verleihen keine Befugnisse.",
              "Personality and appearance do not grant permissions.",
            )}
          </p>
          {error && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
          {saved && <p role="status">{t("Profil gespeichert.", "Profile saved.")}</p>}
          <button>{t("Profil speichern", "Save profile")}</button>
        </form>
      ) : (
        <>
          <p>{str(person, "persona")}</p>
          <p className={styles.muted}>{str(person, "appearance")}</p>
          <Link to={`/crew/${str(person, "id")}`}>{t("Profil bearbeiten", "Edit profile")} →</Link>
        </>
      )}
    </article>
  );
}
function Decision({ approval, locale, onChange }: { approval: Row; locale: Locale; onChange: () => void }) {
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const t = (de: string, en: string) => (locale === "de" ? de : en);
  const binding = (approval.binding ?? approval) as Row;
  async function decide(decision: string) {
    setBusy(true);
    try {
      await request(`/approvals/${str(approval, "id")}/decision`, {
        method: "POST",
        body: { decision },
        revision: approval.revision,
      });
      onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <article className={styles.panel}>
      <div className={styles.panelHeader}>
        <h2>
          {str(approval, "title", str(approval, "actionId", t("Konkrete Aktion prüfen", "Review concrete action")))}
        </h2>
        <Status value={str(approval, "status", "pending")} locale={locale} />
      </div>
      <dl className={styles.details}>
        {[
          ["targetId", t("Ziel", "Target")],
          ["actionId", t("Aktion", "Action")],
          ["argumentsSha256", t("Argumenthash", "Argument hash")],
          ["artifactVersionId", t("Artefaktversion", "Artifact version")],
          ["expiresAt", t("Gültig bis", "Expires")],
        ].map(([key, label]) => (
          <div key={key}>
            <dt>{label}</dt>
            <dd>{str(binding, key, "—")}</dd>
          </div>
        ))}
      </dl>
      <p>{str(approval, "description", str(approval, "recommendation"))}</p>
      {approval.args !== undefined && <pre className={styles.json}>{JSON.stringify(approval.args, null, 2)}</pre>}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <div className={styles.actions}>
        <button
          disabled={busy || ["approved", "denied", "expired"].includes(str(approval, "status"))}
          onClick={() => void decide("approved")}
        >
          {t("Freigeben", "Approve")}
        </button>
        <button className={styles.secondary} disabled={busy} onClick={() => void decide("denied")}>
          {t("Ablehnen", "Deny")}
        </button>
        {Boolean(binding.orderId) && (
          <Link to={`/orders/${str(binding, "orderId")}`}>{t("Rückfrage im Auftrag", "Ask in order")}</Link>
        )}
      </div>
    </article>
  );
}
function Resource({ path, locale, title }: { path: string; locale: Locale; title?: string }) {
  const eventRevision = useEventRevision();
  const [rows, setRows] = useState<Row[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [revision, setRevision] = useState(0);
  const t = (de: string, en: string) => (locale === "de" ? de : en);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    void list(path)
      .then((result) => {
        if (alive) {
          setRows(result);
          setError("");
        }
      })
      .catch((e) => alive && setError(e.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [path, revision, eventRevision]);
  return (
    <section>
      {title && <h2>{title}</h2>}
      {loading ? (
        <div className={styles.skeleton} />
      ) : error ? (
        <div className={styles.error} role="alert">
          <p>
            {t(
              "Diese Ansicht ist noch nicht verfügbar oder der Zugriff fehlt.",
              "This view is unavailable or access is missing.",
            )}
          </p>
          <p>{error}</p>
          <button className={styles.secondary} onClick={() => setRevision((v) => v + 1)}>
            {t("Erneut versuchen", "Try again")}
          </button>
        </div>
      ) : !rows.length ? (
        <Empty>
          {t(
            "Noch keine Einträge. Sobald geprüfte Daten vorliegen, erscheinen sie hier.",
            "No entries yet. Verified data will appear here when available.",
          )}
        </Empty>
      ) : (
        <div className={styles.resourceList}>
          {rows.map((row, index) => (
            <article className={styles.resource} key={str(row, "id", String(index))}>
              <h3>{str(row, "title", str(row, "name", str(row, "modelId", str(row, "type", str(row, "id")))))}</h3>
              {row.status !== undefined && <Status value={str(row, "status")} locale={locale} />}
              <p>{str(row, "summary", str(row, "content", str(row, "description")))}</p>
              <dl className={styles.details}>
                {[
                  "version",
                  "delivery",
                  "canonicalStore",
                  "sha256",
                  "mediaType",
                  "source",
                  "sourceUrl",
                  "scope",
                  "reviewedAt",
                  "updatedAt",
                  "capabilities",
                  "lastSeenAt",
                  "currency",
                  "amount",
                  "dueDate",
                  "externalId",
                ]
                  .filter((key) => row[key] !== undefined)
                  .map((key) => (
                    <div key={key}>
                      <dt>{key}</dt>
                      <dd>{typeof row[key] === "object" ? JSON.stringify(row[key]) : String(row[key])}</dd>
                    </div>
                  ))}
              </dl>
              {typeof row.url === "string" && /^https?:\/\//.test(row.url) && (
                <a target="_blank" rel="noopener noreferrer" href={row.url}>
                  {t("Quelle öffnen", "Open source")}
                </a>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
function Settings({
  section,
  company,
  crew,
  locale,
  onChange,
}: {
  section: string;
  company: Row;
  crew: Row[];
  locale: Locale;
  onChange: () => void;
}) {
  const [error, setError] = useState(""),
    [success, setSuccess] = useState(false);
  const t = (de: string, en: string) => (locale === "de" ? de : en);
  const sections: Record<string, [string, string]> = {
    company: ["Firma", "Company"],
    projects: ["Kunden & Projekte", "Customers & projects"],
    models: ["Modelle", "Models"],
    budget: ["Budget", "Budget"],
    workers: ["Worker", "Workers"],
    channels: ["Kanäle", "Channels"],
    integrations: ["Integrationen", "Integrations"],
    mandates: ["Mandate", "Mandates"],
    schedules: ["Routinen", "Schedules"],
    backups: ["Sicherung & Updates", "Backup & updates"],
  };
  return (
    <>
      <h1>{txt("settings", locale)}</h1>
      <nav className={styles.tabs}>
        {Object.entries(sections).map(([key, label]) => (
          <Link key={key} to={`/settings/${key}`} aria-current={section === key ? "page" : undefined}>
            {label[locale === "de" ? 0 : 1]}
          </Link>
        ))}
      </nav>
      <h2>{sections[section]?.[locale === "de" ? 0 : 1] ?? section}</h2>
      {["models", "integrations"].includes(section) ? (
        <ConfigurationPanel company={company} locale={locale} section={section} />
      ) : section === "projects" ? (
        <Entities locale={locale} />
      ) : section === "workers" ? (
        <Workers locale={locale} />
      ) : section === "channels" ? (
        <Channels company={company} locale={locale} />
      ) : section === "company" ? (
        <form
          className={styles.settingsForm}
          onSubmit={(e) => {
            e.preventDefault();
            void request("/company", {
              method: "PATCH",
              body: Object.fromEntries(new FormData(e.currentTarget)),
              revision: company.revision,
            })
              .then(() => {
                setSuccess(true);
                setError("");
                onChange();
              })
              .catch((e) => setError(e.message));
          }}
        >
          <Field label={t("Firmenname", "Company name")}>
            <input name="name" defaultValue={str(company, "name")} required />
          </Field>
          <Field label={t("Zeitzone", "Timezone")}>
            <input name="timezone" defaultValue={str(company, "timezone", "Europe/Berlin")} required />
          </Field>
          <Field label={t("Sprache", "Language")}>
            <select name="locale" defaultValue={locale}>
              <option value="de">Deutsch</option>
              <option value="en">English</option>
            </select>
          </Field>
          <button>{t("Speichern", "Save")}</button>
          {success && <p role="status">{t("Gespeichert.", "Saved.")}</p>}
          {error && (
            <p role="alert" className={styles.error}>
              {error}
            </p>
          )}
        </form>
      ) : section === "budget" ? (
        <>
          <form
            className={styles.settingsForm}
            onSubmit={(e) => {
              e.preventDefault();
              const form = new FormData(e.currentTarget);
              void request("/budget", {
                method: "POST",
                body: {
                  limitUsdMicros: String(Math.round(Number(form.get("amount")) * 1e6)),
                  startsAt: new Date(String(form.get("startsAt"))).toISOString(),
                  endsAt: new Date(String(form.get("endsAt"))).toISOString(),
                },
              })
                .then(() => {
                  setSuccess(true);
                  setError("");
                  onChange();
                })
                .catch((e) => setError(e.message));
            }}
          >
            <Field label={t("Limit in USD", "Limit in USD")}>
              <input name="amount" type="number" min="0" step="0.01" required />
            </Field>
            <Field label={t("Zeitraum von", "Period starts")}>
              <input name="startsAt" type="date" required />
            </Field>
            <Field label={t("Zeitraum bis", "Period ends")}>
              <input name="endsAt" type="date" required />
            </Field>
            <button>{t("Budgetzeitraum festlegen", "Set budget period")}</button>
            {success && <p role="status">{t("Gespeichert.", "Saved.")}</p>}
            {error && (
              <p role="alert" className={styles.error}>
                {error}
              </p>
            )}
          </form>
          <IntegrationCosts locale={locale} />
          <ModelCosts locale={locale} />
        </>
      ) : (
        <>
          <p className={styles.muted}>
            {t(
              "Verbindungen und Befugnisse gelten erst nach erfolgreicher Prüfung. Nicht verbundene Dienste sind nicht aktiv.",
              "Connections and permissions apply only after successful verification. Unconnected services are inactive.",
            )}
          </p>
          <Resource path={`/${section === "channels" ? "integrations" : section}`} locale={locale} />
          {section === "schedules" && <SchedulePanel crew={crew} locale={locale} />}{" "}
          {section === "mandates" && <MandatePanel company={company} locale={locale} />}
          {section === "backups" && (
            <>
              <BackupPanel locale={locale} />
              <Maintenance locale={locale} />
            </>
          )}
        </>
      )}
      <p>
        <Link to="/setup">{t("Einrichtung fortsetzen", "Resume setup")}</Link>
      </p>
    </>
  );
}
