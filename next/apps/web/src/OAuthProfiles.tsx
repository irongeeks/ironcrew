import { useState, type FormEvent } from "react";
import { Field, Feedback, records, useRemote, type Locale } from "./Operations.tsx";
import { request, string as str, type Row } from "./api.ts";
import styles from "./App.module.css";
const object = (value: unknown): Row =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};
const value = (form: FormData, key: string) => String(form.get(key) ?? "").trim();
function Reference({
  name,
  title,
  initial,
  locale,
  required = true,
}: {
  name: string;
  title: string;
  initial: unknown;
  locale: Locale;
  required?: boolean;
}) {
  const ref = object(initial);
  return (
    <fieldset>
      <legend>{title} · Proton Pass</legend>
      <Field label={`${title} · Share ID`}>
        <input name={`${name}.shareId`} defaultValue={str(ref, "shareId")} maxLength={300} required={required} />
      </Field>
      <Field label={`${title} · Item ID`}>
        <input name={`${name}.itemId`} defaultValue={str(ref, "itemId")} maxLength={300} required={required} />
      </Field>
      <Field label={`${title} · ${locale === "de" ? "Feldname" : "Field name"}`}>
        <input
          name={`${name}.field`}
          defaultValue={str(ref, "field", "password")}
          maxLength={200}
          required={required}
        />
      </Field>
    </fieldset>
  );
}
export default function OAuthProfiles({ locale, onChange }: { locale: Locale; onChange: () => void }) {
  const t = (de: string, en: string) => (locale === "de" ? de : en);
  const configuration = useRemote("/configuration"),
    recovery = useRemote("/recovery");
  const [selected, setSelected] = useState(""),
    [method, setMethod] = useState("client_secret_post"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const targets: Row[] = [
    ...records(configuration.data.connections)
      .filter((c) => ["gdrive", "graph"].includes(str(c, "provider")))
      .map((c) => ({ ...c, collection: "connections" })),
    ...records(configuration.data.mailConnections).map((c) => ({
      ...c,
      provider: "mail",
      collection: "mailConnections",
    })),
  ];
  const target = targets.find((c) => c.id === selected),
    profile = object(target?.oauth),
    generation = recovery.data.generation ?? null;
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!target) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    setMessage("");
    try {
      if (form.get("confirmed") !== "on")
        throw new Error(t("Providerautorisierung bestätigen.", "Confirm provider authorization."));
      if (profile.id && form.get("rotate") !== "on")
        throw new Error(
          t(
            "Für Änderungen vorhandener Profile den neuen Token-Speicher ausdrücklich bestätigen.",
            "Explicitly confirm a new token store when changing an existing profile.",
          ),
        );
      const [latest, currentRecovery] = await Promise.all([request("/configuration"), request("/recovery")]);
      const current = records(latest[String(target.collection)]).find((c) => c.id === target.id);
      const original = records(configuration.data[String(target.collection)]).find((c) => c.id === target.id);
      if (
        !current ||
        JSON.stringify(current) !== JSON.stringify(original) ||
        (currentRecovery.generation ?? null) !== generation
      )
        throw new Error(
          t(
            "Konfiguration oder Wiederherstellung wurde geändert. Ansicht neu laden.",
            "Configuration or recovery changed. Reload the view.",
          ),
        );
      const ref = (name: string) => ({
        provider: "proton-pass",
        shareId: value(form, `${name}.shareId`),
        itemId: value(form, `${name}.itemId`),
        field: value(form, `${name}.field`),
      });
      const scopes = value(form, "scopes").split(/\s+/).filter(Boolean);
      if (new Set(scopes).size !== scopes.length)
        throw new Error(t("Scopes müssen eindeutig sein.", "Scopes must be unique."));
      const oauth = {
        id: !profile.id || form.get("rotate") === "on" ? crypto.randomUUID() : profile.id,
        authorizedGeneration: generation,
        tokenEndpoint: value(form, "tokenEndpoint"),
        clientId: value(form, "clientId"),
        clientAuthentication: method,
        ...(method !== "none" ? { clientSecretRef: ref("clientSecretRef") } : {}),
        refreshTokenRef: ref("refreshTokenRef"),
        encryptionKeyRef: ref("encryptionKeyRef"),
        scopes,
        timeoutMs: Number(value(form, "timeoutMs")),
        ...(value(form, "tlsCaFile") ? { tlsCaFile: value(form, "tlsCaFile") } : {}),
      };
      await request("/configuration", {
        method: "PUT",
        body: {
          ...latest,
          [String(target.collection)]: records(latest[String(target.collection)]).map((c) =>
            c.id === target.id ? { ...c, oauth } : c,
          ),
        },
      });
      configuration.reload();
      onChange();
      setMessage(
        t(
          "OAuth-Verweise für diese Wiederherstellungsgeneration gespeichert. Ein erfolgreicher Providerabruf ist damit noch nicht belegt.",
          "OAuth references saved for this recovery generation. This does not establish a successful provider request.",
        ),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className={styles.panel} aria-label={t("OAuth-Profile", "OAuth profiles")}>
      <h3>{t("OAuth-Profile", "OAuth profiles")}</h3>
      <p>
        {t(
          "Für Google Drive, Microsoft Graph und OAuth-fähige Mailverbindungen. Autorisiere die Anwendung zuerst beim Provider und hinterlege Refresh-Token, Client-Secret und einen 32-Byte-Schlüssel (Base64) in Proton Pass. Hier werden ausschließlich deren Verweise gespeichert.",
          "For Google Drive, Microsoft Graph and OAuth-capable mail connections. Authorize the application with the provider first and store its refresh token, client secret and a 32-byte encryption key (Base64) in Proton Pass. This form stores only their references.",
        )}
      </p>
      <Feedback error={error || configuration.error || recovery.error} message={message} />
      <p>
        {t("Aktuelle Wiederherstellungsgeneration", "Current recovery generation")}:{" "}
        {String(generation ?? t("Erstinstallation", "Initial installation"))}
      </p>
      {!targets.length ? (
        <p>
          {t(
            "Zuerst eine Google-Drive-, Graph- oder Mailverbindung einrichten.",
            "Configure a Google Drive, Graph or mail connection first.",
          )}
        </p>
      ) : (
        <Field label={t("Verbindung für OAuth", "OAuth connection")}>
          <select
            value={selected}
            onChange={(e) => {
              setSelected(e.target.value);
              setMethod(
                str(
                  object(targets.find((c) => c.id === e.target.value)?.oauth),
                  "clientAuthentication",
                  "client_secret_post",
                ),
              );
              setMessage("");
              setError("");
            }}
          >
            <option value="">{t("Verbindung auswählen", "Select connection")}</option>
            {targets.map((c) => (
              <option key={str(c, "id")} value={str(c, "id")}>
                {str(c, "provider")} · {str(c, "username", str(c, "schemaTag", str(c, "id")))}
              </option>
            ))}
          </select>
        </Field>
      )}
      {target && (
        <form key={selected + str(profile, "id")} onSubmit={(e) => void save(e)}>
          <p>
            {t("Geltungsbereich", "Scope")}: {str(object(target.scope), "areaId")} · {str(target, "id")}
          </p>
          {Boolean(profile.id) && (
            <p>
              {t("Gespeichertes Profil", "Saved profile")}: {str(profile, "id")} ·{" "}
              {profile.authorizedGeneration === generation
                ? t(
                    "Generation stimmt überein; Providerstatus noch nicht geprüft.",
                    "Generation matches; provider status is not verified.",
                  )
                : t(
                    "Nach Wiederherstellung erneut beim Provider autorisieren und ausdrücklich bestätigen.",
                    "Reauthorize with the provider after restore and explicitly confirm.",
                  )}
            </p>
          )}
          <Field label={t("Token-Endpunkt (HTTPS)", "Token endpoint (HTTPS)")}>
            <input
              name="tokenEndpoint"
              type="url"
              pattern="https://[^?#]+"
              defaultValue={str(profile, "tokenEndpoint")}
              required
            />
          </Field>
          <Field label="Client ID">
            <input name="clientId" defaultValue={str(profile, "clientId")} maxLength={1000} required />
          </Field>
          <Field label={t("Client-Authentifizierung", "Client authentication")}>
            <select value={method} onChange={(e) => setMethod(e.target.value)}>
              <option value="client_secret_post">client_secret_post</option>
              <option value="client_secret_basic">client_secret_basic</option>
              <option value="none">{t("Öffentlicher Client (none)", "Public client (none)")}</option>
            </select>
          </Field>
          {method !== "none" && (
            <Reference name="clientSecretRef" title="Client-Secret" initial={profile.clientSecretRef} locale={locale} />
          )}
          <Reference name="refreshTokenRef" title="Refresh-Token" initial={profile.refreshTokenRef} locale={locale} />
          <Reference
            name="encryptionKeyRef"
            title={t("Verschlüsselungsschlüssel", "Encryption key")}
            initial={profile.encryptionKeyRef}
            locale={locale}
          />
          <Field label={t("Provider-Scopes (einer je Zeile)", "Provider scopes (one per line)")}>
            <textarea
              name="scopes"
              rows={3}
              defaultValue={Array.isArray(profile.scopes) ? profile.scopes.join("\n") : ""}
              required
            />
          </Field>
          <Field label={t("Zeitlimit in Millisekunden", "Timeout in milliseconds")}>
            <input
              name="timeoutMs"
              type="number"
              min={100}
              max={60000}
              step={1}
              defaultValue={Number(profile.timeoutMs ?? 15000)}
              required
            />
          </Field>
          <Field
            label={t("Eigene TLS-CA-Datei (absoluter Pfad, optional)", "Custom TLS CA file (absolute path, optional)")}
          >
            <input name="tlsCaFile" defaultValue={str(profile, "tlsCaFile")} />
          </Field>
          {Boolean(profile.id) && (
            <label className={styles.check}>
              <input type="checkbox" name="rotate" required />
              {t(
                "Nach bewusster Provider-Neuautorisierung einen neuen lokalen Token-Speicher anlegen; bisherigen rotierten Token-Stand nicht übernehmen.",
                "After deliberate provider reauthorization, create a new local token store without inheriting the previous rotated token state.",
              )}
            </label>
          )}
          <label className={styles.check}>
            <input type="checkbox" name="confirmed" required />
            {t(
              "Ich habe den Providerzugang und die referenzierten Secrets für die angezeigte Wiederherstellungsgeneration geprüft und autorisiere dieses Profil ausdrücklich als CEO.",
              "I verified provider access and referenced secrets for the displayed recovery generation and explicitly authorize this profile as CEO.",
            )}
          </label>
          <button disabled={busy || configuration.loading || recovery.loading || !!recovery.error}>
            {t("OAuth-Profil ausdrücklich speichern", "Explicitly save OAuth profile")}
          </button>
        </form>
      )}
    </section>
  );
}
