import { useEffect, useState, type FormEvent } from "react";
import { list, request, string, type Row } from "./api.ts";
import styles from "./App.module.css";

export function entityScope(row: Row): Row {
  return row.scope && typeof row.scope === "object" ? (row.scope as Row) : {};
}

export default function Entities({ locale }: { locale: "de" | "en" }) {
  const [areas, setAreas] = useState<Row[]>([]),
    [customers, setCustomers] = useState<Row[]>([]),
    [projects, setProjects] = useState<Row[]>([]),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [revision, setRevision] = useState(0);
  const t = (de: string, en: string) => (locale === "de" ? de : en);
  useEffect(() => {
    let alive = true;
    void Promise.all([list("/areas"), list("/customers"), list("/projects")])
      .then(([a, c, p]) => {
        if (alive) {
          setAreas(a);
          setCustomers(c);
          setProjects(p);
          setError("");
          setLoading(false);
        }
      })
      .catch((e) => {
        if (alive) {
          setError(e.message);
          setLoading(false);
        }
      });
    return () => {
      alive = false;
    };
  }, [revision]);
  if (loading) return <p role="status">{t("Wird geladen…", "Loading…")}</p>;
  return (
    <>
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {(["customers", "projects"] as const).map((kind) => (
        <section key={kind} className={styles.panel}>
          <h3>{kind === "customers" ? t("Kunden", "Customers") : t("Projekte", "Projects")}</h3>
          <EntityForm
            key={`new-${kind}`}
            kind={kind}
            areas={areas}
            customers={customers}
            locale={locale}
            onSaved={() => setRevision((r) => r + 1)}
          />
          {(kind === "customers" ? customers : projects).map((row) => (
            <details key={string(row, "id")}>
              <summary>
                {string(row, "name")} · {string(areas.find((a) => a.id === entityScope(row).areaId) ?? {}, "name")}
                {entityScope(row).customerId
                  ? ` · ${string(customers.find((c) => c.id === entityScope(row).customerId) ?? {}, "name")}`
                  : ""}
              </summary>
              <EntityForm
                key={`${string(row, "id")}-${row.revision}`}
                row={row}
                kind={kind}
                areas={areas}
                customers={customers}
                locale={locale}
                onSaved={() => setRevision((r) => r + 1)}
              />
            </details>
          ))}
        </section>
      ))}
    </>
  );
}

function EntityForm({
  row,
  kind,
  areas,
  customers,
  locale,
  onSaved,
}: {
  row?: Row;
  kind: "customers" | "projects";
  areas: Row[];
  customers: Row[];
  locale: "de" | "en";
  onSaved: () => void;
}) {
  const t = (de: string, en: string) => (locale === "de" ? de : en);
  const [areaId, setAreaId] = useState(string(areas[0] ?? {}, "id")),
    [customerId, setCustomerId] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [saved, setSaved] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget,
      values = new FormData(form);
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      await request(`/${kind}${row ? `/${row.id}` : ""}`, {
        method: row ? "PATCH" : "POST",
        revision: row?.revision,
        body: {
          name: values.get("name"),
          description: values.get("description"),
          ...(!row ? { areaId, ...(kind === "projects" && customerId ? { customerId } : {}) } : {}),
        },
      });
      if (!row) form.reset();
      setSaved(true);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className={styles.settingsForm}
      onSubmit={(e) => void submit(e)}
      aria-label={
        row
          ? t("Eintrag bearbeiten", "Edit entry")
          : kind === "customers"
            ? t("Kunde anlegen", "Create customer")
            : t("Projekt anlegen", "Create project")
      }
    >
      <label className={styles.field}>
        {t("Name", "Name")}
        <input name="name" maxLength={200} defaultValue={row ? string(row, "name") : ""} required />
      </label>
      <label className={styles.field}>
        {t("Beschreibung", "Description")}
        <textarea name="description" maxLength={4000} defaultValue={row ? string(row, "description") : ""} />
      </label>
      {!row && (
        <>
          <label className={styles.field}>
            {t("Bereich", "Area")}
            <select
              required
              value={areaId}
              onChange={(e) => {
                setAreaId(e.target.value);
                setCustomerId("");
              }}
            >
              {areas.map((a) => (
                <option key={string(a, "id")} value={string(a, "id")}>
                  {string(a, "name")}
                </option>
              ))}
            </select>
          </label>
          {kind === "projects" && (
            <label className={styles.field}>
              {t("Kunde (optional)", "Customer (optional)")}
              <select value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
                <option value="">{t("Ohne Kunde / intern", "No customer / internal")}</option>
                {customers
                  .filter((c) => entityScope(c).areaId === areaId)
                  .map((c) => (
                    <option key={string(c, "id")} value={string(c, "id")}>
                      {string(c, "name")}
                    </option>
                  ))}
              </select>
            </label>
          )}
        </>
      )}
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {saved && <p role="status">{t("Gespeichert.", "Saved.")}</p>}
      <button disabled={busy || (!row && !areaId)}>
        {row
          ? t("Änderungen speichern", "Save changes")
          : kind === "customers"
            ? t("Kunde anlegen", "Create customer")
            : t("Projekt anlegen", "Create project")}
      </button>
    </form>
  );
}
