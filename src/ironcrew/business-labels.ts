import { useI18n } from "../i18n";
import type { BusinessMetric, BusinessSource } from "../shared/business-dashboard";

/** Source IDs, states and metric keys are owned by the business dashboard API.
 * Record labels, external statuses and arbitrary diagnostics remain source data. */
export function useBusinessLabels() {
  const { t } = useI18n();
  const sourceLabel = (source: BusinessSource) =>
    ({
      proxmox: t({ de: "Proxmox · Gäste", en: "Proxmox · Guests" }),
      "rmm-agents": t({ de: "Tactical RMM · Endpunkte", en: "Tactical RMM · Endpoints" }),
      "rmm-alerts": t({ de: "Tactical RMM · offene Alarme", en: "Tactical RMM · Open alerts" }),
      unifi: t({ de: "UniFi · Geräte", en: "UniFi · Devices" }),
      sevdesk: t({ de: "sevDesk · offene Rechnungen", en: "sevDesk · Open invoices" }),
      lexware: t({ de: "Lexware Office · offene Rechnungen", en: "Lexware Office · Open invoices" }),
    })[source.id] ?? source.label;
  const sourceMessage = (source: BusinessSource) =>
    ({
      not_installed: t({ de: "Zugehöriges Gewerk zuerst installieren.", en: "Install the associated pack first." }),
      not_configured: t({
        de: "Integration nicht konfiguriert. Zugang auf dem Host einrichten.",
        en: "Integration not configured. Set up access on the host.",
      }),
      not_refreshed: t({ de: "Noch nicht abgerufen.", en: "Not fetched yet." }),
      denied: t({
        de: "Werkzeug nicht freigegeben. Agentenrechte im Werkzeugbereich prüfen.",
        en: "Tool access denied. Check agent permissions in the tools area.",
      }),
      approval_required: t({
        de: "Werkzeug benötigt eine Freigabe. Es wurden keine Daten abgerufen.",
        en: "The tool requires approval. No data was fetched.",
      }),
      ok: source.limited
        ? t({
            de: "Begrenzter Ausschnitt. Kennzahlen beziehen sich auf die geladene Auswahl.",
            en: "Limited snapshot. Metrics refer to the loaded selection.",
          })
        : t({
            de: "Vom Quellsystem gelieferte Auswahl. Keine Hochrechnung.",
            en: "Selection returned by the source system. No projections.",
          }),
      error: t({
        de: "Abruf fehlgeschlagen. Verbindung, Leserechte und Antwortformat prüfen. Es wird kein Nullwert angenommen.",
        en: "Fetch failed. Check the connection, read permissions and response format. A zero value is not assumed.",
      }),
    })[source.state];
  const metricLabel = (source: BusinessSource, metric: BusinessMetric) => {
    const labels: Record<string, string> = {
      guests: t({ de: "Gäste ohne Templates", en: "Guests excluding templates" }),
      stopped: t({ de: "Status stopped", en: "Stopped" }),
      endpoints: t({ de: "Gelieferte Endpunkte", en: "Returned endpoints" }),
      online:
        source.id === "unifi"
          ? t({ de: "Davon Status ONLINE", en: "Of which online" })
          : t({ de: "Status online", en: "Online" }),
      alerts: t({ de: "Offene, nicht stummgeschaltete Alarme", en: "Open, unmuted alerts" }),
      errors: t({ de: "Schweregrad error", en: "Error severity" }),
      devices: t({ de: "Geräte in erster Seite", en: "Devices on the first page" }),
      loaded: t({ de: "Geladene offene Rechnungen", en: "Loaded open invoices" }),
      total: t({ de: "Offene Rechnungen laut Quelle", en: "Open invoices reported by source" }),
      overdue: t({ de: "Davon laut Quelle überfällig", en: "Of which overdue according to source" }),
    };
    return labels[metric.key] ?? metric.label;
  };
  return { sourceLabel, sourceMessage, metricLabel };
}
