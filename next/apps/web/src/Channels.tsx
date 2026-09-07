import MailInbox from "./MailInbox.tsx";
import { useState } from "react";
import { request, string as str, type Row } from "./api.ts";
import { Field, Feedback, records, useRemote, type Locale } from "./Operations.tsx";
import styles from "./App.module.css";
export default function Channels({ company, locale }: { company: Row; locale: Locale }) {
  const remote = useRemote("/channels/config"),
    bindings = useRemote("/channels/bindings"),
    areas = useRemote("/areas");
  const [editing, setEditing] = useState<Row | null>(null),
    [provider, setProvider] = useState("telegram"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [challenge, setChallenge] = useState<Row | null>(null);
  const t = (de: string, en: string) => (locale === "de" ? de : en);
  const config = remote.data.config as Row | undefined,
    items = records(config?.channels),
    proton = config?.proton as Row | undefined;
  async function save(next: Row) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await request("/channels/config", { method: "PUT", body: { config: next }, revision: remote.data.revision ?? 0 });
      setMessage(t("Kanalkonfiguration gespeichert.", "Channel configuration saved."));
      remote.reload();
      return true;
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setBusy(false);
    }
  }
  if (remote.loading && !config) return <p>{t("Kanalkonfiguration laden…", "Loading channel configuration…")}</p>;
  if (!config)
    return (
      <Feedback
        error={remote.error || t("Kanalkonfiguration ist nicht verfügbar.", "Channel configuration is unavailable.")}
      />
    );
  return (
    <section>
      <Feedback error={remote.error || bindings.error || error} message={message} />
      <p>
        {t(
          "Eingänge legen Aufträge im festgelegten Bereich an. Nachrichten erteilen keine Freigaben. Öffentliche Provider-Webhooks benötigen einen administrierten HTTPS-Endpunkt.",
          "Inbound channels create orders in the configured scope. Messages cannot approve actions. Public provider webhooks require an administered HTTPS endpoint.",
        )}
      </p>
      <details className={styles.panel}>
        <summary>{t("Proton-Pass-Resolver für Eingänge", "Proton Pass resolver for inbound channels")}</summary>
        <form
          className={styles.settingsForm}
          key={JSON.stringify(proton)}
          onSubmit={(event) => {
            event.preventDefault();
            const f = new FormData(event.currentTarget);
            void save({
              ...config,
              proton: {
                executable: f.get("executable"),
                ...(f.get("sessionDirectory") ? { sessionDirectory: f.get("sessionDirectory") } : {}),
              },
            });
          }}
        >
          <Field label={t("Absoluter pass-cli Pfad", "Absolute pass-cli path")}>
            <input name="executable" defaultValue={str(proton ?? {}, "executable")} required />
          </Field>
          <Field
            label={t("Eigenes Proton-Sitzungsverzeichnis (optional)", "Dedicated Proton session directory (optional)")}
          >
            <input name="sessionDirectory" defaultValue={str(proton ?? {}, "sessionDirectory")} />
          </Field>
          <button disabled={busy}>{t("Resolver speichern", "Save resolver")}</button>
        </form>
      </details>
      <div className={styles.resourceList}>
        {items.map((channel) => {
          const linked = records(bindings.data.items).filter(
            (binding) => binding.provider === channel.provider && binding.accountId === channel.accountId,
          );
          const scope = channel.scope as Row;
          return (
            <article className={styles.resource} key={str(channel, "id")}>
              <h3>
                {str(channel, "provider")} · {str(channel, "accountId")}
              </h3>
              <p>
                {channel.enabled
                  ? t("Eingang aktiviert", "Inbound channel enabled")
                  : t("Eingang deaktiviert", "Inbound channel disabled")}{" "}
                ·{" "}
                {str(
                  records(areas.data.items).find((area) => area.id === scope?.areaId) ?? {},
                  "name",
                  t("Bereich ungeklärt", "Scope unknown"),
                )}
              </p>
              <p className={styles.json}>
                /api/v1/channel-webhooks/{str(channel, "provider")}/{str(channel, "id")}
              </p>
              {linked.map((binding) => (
                <p key={str(binding, "id", str(binding, "userId"))}>
                  {t("Verifizierte CEO-Verknüpfung", "Verified CEO binding")}: {str(binding, "userId")} ·{" "}
                  {str(binding, "verifiedAt")}
                </p>
              ))}
              {!linked.length && (
                <p>
                  {channel.provider === "email"
                    ? t("E-Mail-Absender bleiben externe Identitäten.", "Email senders remain external identities.")
                    : t("Noch keine verifizierte CEO-Verknüpfung.", "No verified CEO binding yet.")}
                </p>
              )}
              <div className={styles.actions}>
                <button
                  className={styles.secondary}
                  onClick={() => {
                    setEditing(channel);
                    setProvider(str(channel, "provider"));
                  }}
                >
                  {t("Kanal bearbeiten", "Edit channel")}
                </button>
                {channel.provider !== "email" && (
                  <button
                    className={styles.secondary}
                    disabled={!channel.enabled || busy}
                    onClick={async () => {
                      setBusy(true);
                      setError("");
                      try {
                        const value = await request("/channels/challenge", {
                          method: "POST",
                          body: { provider: channel.provider, scope: channel.scope },
                        });
                        setChallenge({ ...value, provider: channel.provider, accountId: channel.accountId });
                      } catch (error) {
                        setError(error instanceof Error ? error.message : String(error));
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    {t("CEO-Verknüpfung beginnen", "Start CEO binding")}
                  </button>
                )}
              </div>
            </article>
          );
        })}
      </div>
      {challenge && (
        <section className={styles.panel}>
          <h3>{t("Verknüpfung im erlaubten Kanal abschließen", "Complete binding in the allowed channel")}</h3>
          <p>
            {t("Einmalig gültig bis", "Single use until")}: {str(challenge, "expiresAt")}
          </p>
          <pre className={styles.json}>
            {challenge.provider === "telegram"
              ? `/ironcrew_bind ${str(challenge, "challenge")}`
              : `/ironcrew-bind token:${str(challenge, "challenge")}`}
          </pre>
          <p>
            {t(
              "Die Benutzer-ID wird erst aus dem authentifizierten Providerereignis übernommen.",
              "The user ID is accepted only from the authenticated provider event.",
            )}
          </p>
          <button
            className={styles.secondary}
            onClick={() => {
              bindings.reload();
              setChallenge(null);
            }}
          >
            {t("Verknüpfungsstand neu laden", "Refresh binding status")}
          </button>
        </section>
      )}
      <form
        className={styles.settingsForm}
        key={str(editing ?? {}, "id", "new")}
        onSubmit={async (event) => {
          event.preventDefault();
          const f = new FormData(event.currentTarget);
          const currentScope = editing?.scope as Row | undefined;
          const channel: Row = {
            id: editing?.id ?? crypto.randomUUID(),
            enabled: f.get("enabled") === "on",
            provider,
            accountId: f.get("accountId"),
            scope: {
              ...currentScope,
              companyId: company.id,
              areaId: f.get("areaId"),
              ...(f.get("customerId") ? { customerId: f.get("customerId") } : { customerId: undefined }),
              ...(f.get("projectId") ? { projectId: f.get("projectId") } : { projectId: undefined }),
            },
            kind: f.get("kind"),
            budgetLimitUsdMicros: String(Math.round(Number(f.get("budget")) * 1000000)),
            ...(provider !== "email"
              ? {
                  conversationIds: String(f.get("conversations"))
                    .split("\n")
                    .map((value) => value.trim())
                    .filter(Boolean),
                }
              : {}),
            ...(provider === "discord"
              ? { publicKeyHex: f.get("publicKey") }
              : {
                  secretRef: {
                    provider: "proton-pass",
                    shareId: f.get("shareId"),
                    itemId: f.get("itemId"),
                    field: f.get("secretField"),
                  },
                }),
          };
          if (
            await save({
              ...config,
              channels: editing ? items.map((item) => (item.id === editing.id ? channel : item)) : [...items, channel],
            })
          ) {
            setEditing(null);
            setProvider("telegram");
          }
        }}
      >
        <h3>{editing ? t("Kanal ändern", "Edit channel") : t("Eingang konfigurieren", "Configure inbound channel")}</h3>
        <Field label={t("Eingangsprovider", "Inbound provider")}>
          <select value={provider} onChange={(event) => setProvider(event.target.value)} disabled={!!editing}>
            <option value="telegram">Telegram</option>
            <option value="discord">Discord</option>
            <option value="email">E-Mail / Mailbridge</option>
          </select>
        </Field>
        <Field label={t("Feste Provider-Account-ID", "Fixed provider account ID")}>
          <input name="accountId" defaultValue={str(editing ?? {}, "accountId")} required />
        </Field>
        <Field label={t("Zielbereich für neue Aufträge", "Target area for incoming orders")}>
          <select name="areaId" required defaultValue={str((editing?.scope as Row) ?? {}, "areaId")}>
            {records(areas.data.items).map((area) => (
              <option key={str(area, "id")} value={str(area, "id")}>
                {str(area, "name")}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("Kunden-ID (optional)", "Customer ID (optional)")}>
          <input name="customerId" defaultValue={str((editing?.scope as Row) ?? {}, "customerId")} />
        </Field>
        <Field label={t("Projekt-ID (optional)", "Project ID (optional)")}>
          <input name="projectId" defaultValue={str((editing?.scope as Row) ?? {}, "projectId")} />
        </Field>
        <Field label={t("Auftragstyp am Eingang", "Inbound order type")}>
          <select name="kind" defaultValue={str(editing ?? {}, "kind", "research")}>
            <option value="research">{t("Recherche", "Research")}</option>
            <option value="website">Website</option>
            <option value="incident">{t("IT-Störung", "Incident")}</option>
            <option value="finance">{t("Finanzen", "Finance")}</option>
          </select>
        </Field>
        <Field label={t("Kostenlimit pro Auftrag USD", "Per-order budget USD")}>
          <input
            name="budget"
            type="number"
            min="0"
            step=".01"
            defaultValue={Number(editing?.budgetLimitUsdMicros ?? 0) / 1000000}
            required
          />
        </Field>
        {provider !== "email" && (
          <Field label={t("Erlaubte Chat-/Kanal-IDs (eine je Zeile)", "Allowed chat/channel IDs (one per line)")}>
            <textarea
              name="conversations"
              rows={3}
              defaultValue={Array.isArray(editing?.conversationIds) ? editing.conversationIds.join("\n") : ""}
              required
            />
          </Field>
        )}
        {provider === "discord" ? (
          <Field label={t("Öffentlicher Discord-Schlüssel (64 Hexzeichen)", "Public Discord key (64 hex characters)")}>
            <input
              name="publicKey"
              pattern="[a-fA-F0-9]{64}"
              defaultValue={str(editing ?? {}, "publicKeyHex")}
              required
            />
          </Field>
        ) : (
          <fieldset>
            <legend>{t("Proton-Referenz des Eingangsgeheimnisses", "Proton reference for inbound secret")}</legend>
            {[
              ["shareId", "Share-ID"],
              ["itemId", "Item-ID"],
              ["secretField", t("Feldname", "Field name")],
            ].map(([name, label]) => (
              <Field key={name} label={label!}>
                <input
                  name={name}
                  defaultValue={str(
                    (editing?.secretRef as Row) ?? {},
                    name === "secretField" ? "field" : name!,
                    name === "secretField" ? "password" : "",
                  )}
                  required
                />
              </Field>
            ))}
            <p>
              {provider === "telegram"
                ? t(
                    "Hier das Webhook-Secret referenzieren, nicht den Bot-Token.",
                    "Reference the webhook secret here, not the bot token.",
                  )
                : t(
                    "Die Mailbridge signiert Timestamp und unveränderte JSON-Bytes mit dem referenzierten HMAC-Geheimnis.",
                    "The mail bridge signs timestamp and raw JSON bytes with the referenced HMAC secret.",
                  )}
            </p>
          </fieldset>
        )}
        <label className={styles.check}>
          <input name="enabled" type="checkbox" defaultChecked={editing?.enabled === true} />
          {t("Eingang ausdrücklich aktivieren", "Explicitly enable inbound channel")}
        </label>
        <div className={styles.actions}>
          <button disabled={busy}>{t("Eingang speichern", "Save inbound channel")}</button>
          {editing && (
            <button
              type="button"
              className={styles.secondary}
              onClick={() => {
                setEditing(null);
                setProvider("telegram");
              }}
            >
              {t("Bearbeitung abbrechen", "Cancel edit")}
            </button>
          )}
        </div>
      </form>
      <MailInbox locale={locale} />
    </section>
  );
}
