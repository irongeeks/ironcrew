import { useEffect, useRef, useState } from "react";
import { list, request, string as str, type Row } from "./api.ts";
import { records, useRemote, type Locale } from "./Operations.tsx";
import styles from "./App.module.css";
const eventLabels: Record<string, [string, string]> = {
  "order.created": ["Auftrag angelegt", "Order created"],
  "order.updated": ["Auftrag aktualisiert", "Order updated"],
  "order.plan_committed": ["Arbeitsplan gespeichert", "Work plan saved"],
  "message.created": ["Nachricht eingegangen", "Message received"],
  "model.rated": ["Modellbewertung gespeichert", "Model rating recorded"],
  "model.prepared": ["Modellaufruf vorbereitet", "Model turn prepared"],
  "model.completed": ["Modellantwort gespeichert", "Model response recorded"],
  "model.interrupted": ["Modellantwort ungeklärt", "Model response unknown"],
  "tool.started": ["Werkzeugaktion gestartet", "Tool action started"],
  "tool.result": ["Werkzeugergebnis gespeichert", "Tool result recorded"],
  "research.watch_checked": ["Quellenbeobachtung geprüft", "Source watch checked"],
  "research.watch_created": ["Quellenbeobachtung angelegt", "Source watch created"],
  "research.watch_reviewed": ["Quellenänderung bewertet", "Source change reviewed"],
  "channel.configuration_changed": ["Kanalkonfiguration geändert", "Channel configuration changed"],
  "channel.received": ["Kanaleingang erfasst", "Channel message recorded"],
  "channel.bound": ["Kanalidentität verknüpft", "Channel identity bound"],
};
export default function Notifications({ locale }: { locale: Locale }) {
  const company = useRemote("/company");
  return str(company.data, "id") ? (
    <NotificationCenter key={str(company.data, "id")} companyId={str(company.data, "id")} locale={locale} />
  ) : null;
}
function NotificationCenter({ companyId, locale }: { companyId: string; locale: Locale }) {
  const [open, setOpen] = useState(false),
    [events, setEvents] = useState<Row[]>([]),
    [approvals, setApprovals] = useState<Row[]>([]),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [more, setMore] = useState(false);
  const storageKey = `ironcrew.notifications.read.${companyId}`,
    [read, setRead] = useState(() => Number(localStorage.getItem(storageKey) ?? 0));
  const sequence = useRef(0),
    busy = useRef(false),
    dialog = useRef<HTMLDialogElement>(null),
    trigger = useRef<HTMLButtonElement>(null);
  const t = (de: string, en: string) => (locale === "de" ? de : en);
  useEffect(() => {
    let alive = true;
    async function load() {
      if (busy.current) return;
      busy.current = true;
      setLoading(true);
      try {
        let hasMore = false;
        const added: Row[] = [];
        for (let page = 0; page < 10; page++) {
          const value = await request(`/notifications?after=${sequence.current}&limit=200`);
          if (!alive) return;
          const items = records(value.items);
          added.push(...items);
          sequence.current = Math.max(
            sequence.current,
            Number(value.lastSequence ?? 0),
            ...items.map((item) => Number(item.sequence)),
          );
          hasMore = !!value.nextCursor;
          if (!hasMore || !items.length) break;
        }
        const decisions = await list("/approvals");
        if (!alive) return;
        setEvents((previous) =>
          [...new Map([...previous, ...added].map((item) => [Number(item.sequence), item])).values()]
            .sort((a, b) => Number(b.sequence) - Number(a.sequence))
            .slice(0, 200),
        );
        setApprovals(decisions.filter((item) => !["approved", "denied", "expired"].includes(str(item, "status"))));
        setMore(hasMore);
        setError("");
      } catch (error) {
        if (alive) setError(error instanceof Error ? error.message : String(error));
      } finally {
        busy.current = false;
        if (alive) setLoading(false);
      }
    }
    void load();
    const refresh = () => void load();
    window.addEventListener("ironcrew:update", refresh);
    window.addEventListener("ironcrew:notifications-refresh", refresh);
    return () => {
      alive = false;
      window.removeEventListener("ironcrew:update", refresh);
      window.removeEventListener("ironcrew:notifications-refresh", refresh);
    };
  }, [companyId]);
  useEffect(() => {
    if (open) dialog.current?.showModal();
  }, [open]);
  const close = () => {
      dialog.current?.close();
      setOpen(false);
      window.requestAnimationFrame(() => trigger.current?.focus());
    },
    unread = events.filter((event) => Number(event.sequence) > read).length;
  const markRead = () => {
    const value = Math.max(read, ...events.map((event) => Number(event.sequence)));
    localStorage.setItem(storageKey, String(value));
    setRead(value);
  };
  const navigate = (href: string) => {
    history.pushState(null, "", href);
    window.dispatchEvent(new PopStateEvent("popstate"));
    close();
  };
  return (
    <>
      <button
        ref={trigger}
        className={styles.secondary}
        onClick={() => setOpen(true)}
        aria-label={t(
          `Benachrichtigungen öffnen, ${unread} neue Ereignisse`,
          `Open notifications, ${unread} new events`,
        )}
      >
        {t("Hinweise", "Updates")}
        {unread > 0 && <span className={styles.notificationCount}> {unread}</span>}
      </button>
      {open && (
        <dialog
          ref={dialog}
          className={styles.dialog}
          aria-label={t("Benachrichtigungszentrum", "Notification center")}
          onCancel={close}
        >
          <div className={styles.panelHeader}>
            <h2>{t("Benachrichtigungen", "Notifications")}</h2>
            <button className={styles.secondary} onClick={close}>
              {t("Schließen", "Close")}
            </button>
          </div>
          {error && (
            <p role="alert" className={styles.error}>
              {error}
            </p>
          )}
          <h3>{t("Offene Entscheidungen", "Pending decisions")}</h3>
          {approvals.length ? (
            <button className={styles.secondary} onClick={() => navigate("/decisions")}>
              {t(`${approvals.length} Entscheidungen prüfen`, `Review ${approvals.length} decisions`)}
            </button>
          ) : (
            <p>{t("Keine offenen Entscheidungen gemeldet.", "No pending decisions reported.")}</p>
          )}
          <div className={styles.actions}>
            <button className={styles.secondary} disabled={!events.length} onClick={markRead}>
              {t("Angezeigte Ereignisse als gelesen markieren", "Mark displayed events as read")}
            </button>
            <button
              className={styles.secondary}
              disabled={loading}
              onClick={() => window.dispatchEvent(new Event("ironcrew:notifications-refresh"))}
            >
              {t("Aktualisieren", "Refresh")}
            </button>
          </div>
          <p className={styles.muted}>
            {t(
              "Die letzten 200 geladenen Ereignisse. Lesestand gilt in diesem Browser und ändert keine Freigabe.",
              "Latest 200 loaded events. Read status applies in this browser and does not change approvals.",
            )}
          </p>
          {more && (
            <p className={styles.warning}>
              {t(
                "Weitere Ereignisse vorhanden. Aktualisieren lädt den nächsten Abschnitt.",
                "More events are available. Refresh loads the next section.",
              )}
            </p>
          )}
          <ol className={styles.notificationList}>
            {events.map((event) => (
              <li
                key={String(event.sequence)}
                className={Number(event.sequence) > read ? styles.notificationUnread : undefined}
              >
                <strong>{eventLabels[str(event, "type")]?.[locale === "de" ? 0 : 1] ?? str(event, "type")}</strong>
                <time dateTime={str(event, "occurredAt")}>
                  {str(event, "occurredAt")
                    ? new Date(str(event, "occurredAt")).toLocaleString(locale)
                    : t("Zeitpunkt nicht verfügbar", "Time unavailable")}
                </time>
                {Boolean(event.orderId) && (
                  <button className={styles.secondary} onClick={() => navigate(`/orders/${str(event, "orderId")}`)}>
                    {t("Auftrag öffnen", "Open order")}
                  </button>
                )}
              </li>
            ))}
          </ol>
          {!events.length && (
            <p>
              {loading
                ? t("Ereignisse laden…", "Loading events…")
                : t("Noch keine Ereignisse geladen.", "No events loaded yet.")}
            </p>
          )}
        </dialog>
      )}
    </>
  );
}
