import MailVoucherImport from "./MailVoucherImport.tsx";
import { useState } from "react";
import { request, string as str, type Row } from "./api.ts";
import { Field, Feedback, records, useRemote, type Locale } from "./Operations.tsx";
import styles from "./App.module.css";
export default function MailInbox({ locale }: { locale: Locale }) {
  const remote = useRemote("/mail-inbox"),
    config = useRemote("/configuration"),
    areas = useRemote("/areas");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [selected, setSelected] = useState<Row | null>(null);
  const t = (de: string, en: string) => (locale === "de" ? de : en);
  const targets = records(remote.data.targets),
    policies = records(remote.data.policies),
    messages = records(remote.data.messages);
  async function perform(endpoint: string, body: Row, method = "POST", revision?: unknown) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await request(endpoint, { method, body, revision });
      remote.reload();
      config.reload();
      setNotice(t("Gespeichert.", "Saved."));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function open(id: string) {
    setBusy(true);
    setError("");
    try {
      setSelected(await request(`/mail-inbox/messages/${id}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label={t("E-Mail-Eingang", "Email inbox")}>
      <h3>{t("E-Mail-Eingang", "Email inbox")}</h3>
      <Feedback error={error || remote.error} message={notice} />
      <p>
        {t(
          "Postfächer werden nach einer ausdrücklich aktivierten Eingangsregel abgerufen. Absender und Inhalt einer E-Mail erteilen keine Freigabe.",
          "Mailboxes are polled under an explicitly enabled inbound policy. Email sender and content never grant approval.",
        )}
      </p>
      {remote.loading && <p role="status">{t("Eingang wird geladen…", "Loading inbox…")}</p>}
      {targets.length === 0 && (
        <p>{t("Noch kein lesbares Postfach eingerichtet.", "No readable mailbox configured yet.")}</p>
      )}
      <details>
        <summary>{t("TLS-Postfach einrichten", "Configure TLS mailbox")}</summary>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget),
              area = records(areas.data.items).find((a) => a.id === f.get("areaId"));
            if (!area) return;
            const scope = { companyId: area.companyId, areaId: area.id };
            const connection = {
              id: crypto.randomUUID(),
              scope,
              host: f.get("host"),
              port: Number(f.get("port")),
              username: f.get("username"),
              from: f.get("from"),
              mailbox: f.get("mailbox"),
              tlsMode: f.get("tlsMode"),
              enabledTools: ["mail.read"],
              secretRef: {
                provider: "proton-pass",
                shareId: f.get("shareId"),
                itemId: f.get("itemId"),
                field: f.get("field"),
              },
            };
            void perform(
              "/configuration",
              { ...config.data, mailConnections: [...records(config.data.mailConnections), connection] },
              "PUT",
            );
          }}
        >
          <Field label={t("Bereich", "Area")}>
            <select required name="areaId">
              <option value="">{t("Auswählen", "Select")}</option>
              {records(areas.data.items).map((a) => (
                <option key={str(a, "id")} value={str(a, "id")}>
                  {str(a, "name")}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t("IMAP-Server", "IMAP server")}>
            <input required name="host" placeholder="imap.example.org" />
          </Field>
          <Field label={t("Port", "Port")}>
            <input required name="port" type="number" min="1" max="65535" defaultValue="993" />
          </Field>
          <Field label={t("Verschlüsselung", "Encryption")}>
            <select name="tlsMode">
              <option value="implicit">TLS</option>
              <option value="starttls">STARTTLS</option>
            </select>
          </Field>
          <Field label={t("Benutzername", "Username")}>
            <input required name="username" autoComplete="off" />
          </Field>
          <Field label={t("Postfachadresse", "Mailbox address")}>
            <input required type="email" name="from" />
          </Field>
          <Field label={t("Ordner", "Folder")}>
            <input required name="mailbox" defaultValue="INBOX" />
          </Field>
          <p>
            {t(
              "Zugang über die bereits eingerichtete Proton-Pass-Verbindung. Hier werden nur Referenzen gespeichert.",
              "Credentials use the configured Proton Pass connection. Only references are stored here.",
            )}
          </p>
          <Field label="Proton Share ID">
            <input required name="shareId" />
          </Field>
          <Field label="Proton Item ID">
            <input required name="itemId" />
          </Field>
          <Field label={t("Proton-Feld", "Proton field")}>
            <input required name="field" defaultValue="password" />
          </Field>
          <button disabled={busy || config.loading}>
            {t("Postfach zum Lesen speichern", "Save mailbox for reading")}
          </button>
        </form>
      </details>
      {targets.length > 0 && (
        <details>
          <summary>{t("Eingangsregel erstellen", "Create inbound policy")}</summary>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget),
                target = targets.find((x) => x.id === f.get("targetId"));
              if (!target) return;
              void perform("/mail-inbox/policies", {
                targetId: target.id,
                targetConfigSha256: target.targetConfigSha256,
                enabled: f.get("enabled") === "on",
                expiresAt: new Date(String(f.get("expiresAt"))).toISOString(),
                kind: f.get("kind"),
                budgetLimitUsdMicros: "0",
                pollIntervalSeconds: Number(f.get("interval")),
              });
            }}
          >
            <Field label={t("Postfach", "Mailbox")}>
              <select name="targetId" required>
                {targets
                  .filter((x) => !policies.some((p) => p.targetId === x.id))
                  .map((x) => (
                    <option value={str(x, "id")} key={str(x, "id")}>
                      {str(x, "username")} · {str(x, "mailbox")}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label={t("Auftragsart für neue Eingänge", "Order type for new messages")}>
              <select name="kind">
                <option value="research">{t("Recherche", "Research")}</option>
                <option value="finance">{t("Finanzen / Belege", "Finance / vouchers")}</option>
                <option value="incident">{t("IT-Störung", "IT incident")}</option>
                <option value="website">Website</option>
              </select>
            </Field>
            <Field label={t("Abrufabstand in Sekunden", "Polling interval in seconds")}>
              <input name="interval" type="number" min="30" max="86400" defaultValue="300" required />
            </Field>
            <Field label={t("Freigabe gültig bis", "Authorized until")}>
              <input name="expiresAt" type="datetime-local" required />
            </Field>
            <Field label={t("Automatischen Abruf ausdrücklich aktivieren", "Explicitly enable automatic polling")}>
              <input name="enabled" type="checkbox" />
            </Field>
            <p>
              {t(
                "Eingangsaufträge erhalten zunächst kein Modellbudget. Die Regel erlaubt keinen Versand.",
                "Inbound orders initially have no model budget. This policy does not authorize sending.",
              )}
            </p>
            <button disabled={busy}>{t("Eingangsregel speichern", "Save inbound policy")}</button>
          </form>
        </details>
      )}
      <div className={styles.resourceList}>
        {policies.map((p) => (
          <article className={styles.resource} key={str(p, "id")}>
            <h4>{str(targets.find((x) => x.id === p.targetId) ?? {}, "username", str(p, "targetId"))}</h4>
            <p>
              {p.enabled ? t("Abruf aktiv", "Polling enabled") : t("Abruf pausiert", "Polling paused")} ·{" "}
              {str(p, "expiresAt")}
            </p>
            <button
              disabled={busy || !p.enabled}
              onClick={() => void perform(`/mail-inbox/policies/${str(p, "id")}/poll`, {})}
            >
              {t("Jetzt abrufen", "Poll now")}
            </button>
            <button
              disabled={busy}
              onClick={() => {
                const {
                  id: _id,
                  scope: _scope,
                  approvedBy: _actor,
                  generation: _gen,
                  nextPollAt: _next,
                  revision,
                  lastErrorCode: _lastError,
                  ...body
                } = p;
                void perform(`/mail-inbox/policies/${str(p, "id")}`, { ...body, enabled: !p.enabled }, "PUT", revision);
              }}
            >
              {p.enabled ? t("Pausieren", "Pause") : t("Abruf aktivieren", "Enable polling")}
            </button>
          </article>
        ))}
      </div>
      {messages.length === 0 && !remote.loading && (
        <p>{t("Noch keine aufgenommenen E-Mails.", "No ingested emails yet.")}</p>
      )}
      <div className={styles.resourceList}>
        {messages.map((m) => (
          <article key={str(m, "id")} className={styles.resource}>
            <h4>{str(m, "subject", t("Ohne Betreff", "No subject"))}</h4>
            <p>
              {str(m, "from")} · {str(m, "receivedAt")} · {str(m, "state")}
            </p>
            <button disabled={busy} onClick={() => void open(str(m, "id"))}>
              {t("Original und Anhänge ansehen", "View original and attachments")}
            </button>
          </article>
        ))}
      </div>
      {selected && (
        <article className={styles.resource} aria-label={t("Ausgewählte E-Mail", "Selected email")}>
          <h4>{str(selected, "subject")}</h4>
          <p className={styles.warning}>{t("Externer, unverifizierter Inhalt", "External, unverified content")}</p>
          <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
            {str(selected, "text", t("Kein Textteil vorhanden.", "No text part available."))}
          </p>
          {selected.original && typeof selected.original === "object" ? (
            <a
              href={`/api/v1/mail-inbox/messages/${str(selected, "id")}/blobs/${str(selected.original as Row, "sha256")}`}
              download
            >
              {t("Original-E-Mail herunterladen", "Download original email")}
            </a>
          ) : null}
          <ul>
            {records(selected.attachments).map((a) => (
              <li key={str(a, "sha256")}>
                <a download href={`/api/v1/mail-inbox/messages/${str(selected, "id")}/blobs/${str(a, "sha256")}`}>
                  {str(a, "filename", t("Anhang", "Attachment"))}
                </a>{" "}
                · {str(a, "contentType")}
              </li>
            ))}
          </ul>
          {selected.orderId ? (
            <a href={`/orders/${str(selected, "orderId")}`}>
              {t("Zugehörigen Auftrag öffnen", "Open associated order")}
            </a>
          ) : null}
          <MailVoucherImport
            message={selected}
            locale={locale}
            busy={busy}
            onImport={(body) => perform(`/mail-inbox/messages/${str(selected, "id")}/finance`, body)}
          />
          <button onClick={() => setSelected(null)}>{t("Detail schließen", "Close detail")}</button>
        </article>
      )}
    </section>
  );
}
