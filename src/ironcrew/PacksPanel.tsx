/**
 * Gewerke — what this company does, and what it would need to do it.
 *
 * The panel is built around one honest signal. Every integration shows
 * `configured` as the server reported it, and the server reports it true only
 * when an adapter was registered at boot from real environment variables. So
 * an operator sees "Proxmox: nicht konfiguriert — PROXMOX_URL,
 * PROXMOX_TOKEN_ID, PROXMOX_TOKEN_SECRET" rather than a switch that fails
 * when pressed. That is Phase 4's "no fake buttons" made visible.
 *
 * Installing changes the org chart, so the button is only useful to an owner;
 * a 403 from the server is what actually stops anyone else, and this panel
 * shows that refusal rather than hiding the control. Hiding a control is a
 * courtesy — the refusal is the security.
 */

import { useCallback, useEffect, useState } from "react";
import { api, serverMessage } from "./api";
import type { BusinessPackSummary, PackDetail } from "./types";

interface PacksPanelProps {
  onClose(): void;
  client?: Pick<typeof api, "packs" | "pack" | "installPack" | "uninstallPack" | "testPackIntegration">;
}

export function PacksPanel({ onClose, client = api }: PacksPanelProps): React.JSX.Element {
  const [packs, setPacks] = useState<BusinessPackSummary[]>([]);
  const [detail, setDetail] = useState<PackDetail | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [probes, setProbes] = useState<Record<string, { ok: boolean; message: string }>>({});

  const load = useCallback(async () => {
    try {
      setPacks((await client.packs()).packs);
    } catch (err) {
      setError(serverMessage(err));
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const open = async (key: string) => {
    setError(null);
    try {
      setDetail(await client.pack(key));
    } catch (err) {
      setError(serverMessage(err));
    }
  };

  const install = async (key: string) => {
    setBusy(key);
    setError(null);
    setMessage(null);
    try {
      const result = await client.installPack(key);
      setMessage(
        `Installiert: ${result.created.agents} Posten, ${result.created.tools} Werkzeuge, ` +
          `${result.created.routines} Routinen (aus). Die Routinen laufen erst, wenn du sie einschaltest.`,
      );
      await load();
    } catch (err) {
      setError(serverMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const uninstall = async (key: string) => {
    setBusy(key);
    setError(null);
    setMessage(null);
    try {
      const result = await client.uninstallPack(key);
      // What stayed behind matters more than what went: an operator who is
      // not told is an operator who finds it by accident later.
      const kept =
        result.kept.length > 0 ? ` Behalten: ${result.kept.map((k) => `${k.key} (${k.reason})`).join(", ")}` : "";
      setMessage(
        `Entfernt: ${result.removed.agents} Posten, ${result.removed.routines} Routinen; ` +
          `${result.disabledTools} Werkzeuge abgeschaltet statt gelöscht.${kept}`,
      );
      await load();
    } catch (err) {
      setError(serverMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const probe = async (packKey: string, integrationKey: string) => {
    setProbes((prev) => ({ ...prev, [integrationKey]: { ok: false, message: "prüfe …" } }));
    try {
      const result = await client.testPackIntegration(packKey, integrationKey);
      setProbes((prev) => ({ ...prev, [integrationKey]: result }));
    } catch (err) {
      setProbes((prev) => ({ ...prev, [integrationKey]: { ok: false, message: serverMessage(err) } }));
    }
  };

  return (
    <div className="ic-modal" role="dialog" aria-label="Gewerke">
      <div className="ic-modal-body ic-packs-panel">
        <header>
          <h2>Gewerke</h2>
          <button type="button" onClick={onClose} aria-label="Schließen">
            ×
          </button>
        </header>

        {error && <p className="ic-identity-error">{error}</p>}
        {message && <p className="ic-identity-ok">{message}</p>}

        {packs.map((pack) => (
          <section key={pack.key} className="ic-pack" data-installed={pack.installed}>
            <div className="ic-pack-head">
              <h3>
                {pack.label} <small>{pack.version}</small>
              </h3>
              <div>
                <button type="button" onClick={() => void open(pack.key)}>
                  Ansehen
                </button>
                {pack.installed ? (
                  <button type="button" onClick={() => void uninstall(pack.key)} disabled={busy === pack.key}>
                    Entfernen
                  </button>
                ) : (
                  <button type="button" onClick={() => void install(pack.key)} disabled={busy === pack.key}>
                    Installieren
                  </button>
                )}
              </div>
            </div>
            <p>{pack.summary}</p>
            <p className="ic-pack-counts">
              {pack.counts.departments} Abteilungen · {pack.counts.agents} Posten · {pack.counts.tools} Werkzeuge ·{" "}
              {pack.counts.routines} Routinen
            </p>

            {pack.integrations.length > 0 && (
              <ul className="ic-pack-integrations">
                {pack.integrations.map((integration) => (
                  <li key={integration.key} data-configured={integration.configured}>
                    <strong>{integration.label}</strong>{" "}
                    {integration.configured ? (
                      <>
                        <span className="ic-pack-ok">konfiguriert</span>{" "}
                        <button type="button" onClick={() => void probe(pack.key, integration.key)}>
                          Verbindung prüfen
                        </button>
                      </>
                    ) : (
                      <span className="ic-pack-missing">
                        nicht konfiguriert —{" "}
                        {integration.env.map((e) => e.name + (e.optional ? " (optional)" : "")).join(", ")}
                      </span>
                    )}
                    {probes[integration.key] && (
                      <div className={probes[integration.key].ok ? "ic-identity-ok" : "ic-identity-error"}>
                        {probes[integration.key].message}
                      </div>
                    )}
                    <div className="ic-pack-summary">{integration.summary}</div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}

        {detail && (
          <section className="ic-pack-detail">
            <h3>{detail.pack.label} — was dazukommt</h3>
            <h4>Posten</h4>
            <ul>
              {detail.agents.map((agent) => (
                <li key={agent.key}>
                  <strong>{agent.displayName}</strong> — {agent.professionalRole} ({agent.department}, max. Risiko{" "}
                  {agent.maxRiskLevel})<div className="ic-pack-summary">{agent.roleSummary}</div>
                </li>
              ))}
            </ul>
            {detail.tools.length > 0 && (
              <>
                <h4>Werkzeuge</h4>
                <ul>
                  {detail.tools.map((tool) => (
                    <li key={tool.key}>
                      <code>{tool.key}</code> — {tool.label} ({tool.risk_class})
                    </li>
                  ))}
                </ul>
              </>
            )}
            {detail.routines.length > 0 && (
              <>
                <h4>Routinen (werden ausgeschaltet installiert)</h4>
                <ul>
                  {detail.routines.map((routine) => (
                    <li key={routine.key}>
                      <strong>{routine.name}</strong> — alle {Math.round(routine.interval_minutes / 60)} h
                      <div className="ic-pack-summary">{routine.instruction}</div>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
