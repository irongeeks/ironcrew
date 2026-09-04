/**
 * IronCrew — business pack: MSP / IT operations.
 *
 * What a managed service provider adds to the company: a service desk, the
 * four operations posts that actually exist in such a shop (Linux and
 * virtualisation, Windows/AD/M365, network, backup and monitoring), the
 * read-only sources those posts work from, and the recurring work that fills
 * an MSP's week.
 *
 * TIER-0 SEPARATION: WHY THIS PACK SHIPS NOTHING THAT CHANGES ANYTHING
 *
 * An MSP holds the keys to its customers' identity systems. Domain Admin,
 * Enterprise Admin, the hypervisor root token, the firewall's admin account —
 * Tier 0, the tier from which every other tier can be taken. A pack that
 * handed an agent those credentials would not be "automating IT operations";
 * it would have moved the customer's entire security boundary into a prompt,
 * where a poisoned monitoring message, a crafted ticket subject or a plain
 * misunderstanding is enough to spend it. The customer's tiering model, their
 * change process and their insurance all assume a human is on the other end of
 * a Tier-0 change. This pack does not quietly break that assumption.
 *
 * So every tool declared here is risk class `read`. There is deliberately no
 * "restart the VM", no "reset the password", no "push the patch", and no
 * jumphost automation: what this crew produces is findings, prioritised lists
 * and prepared change proposals that a human executes. Those are the parts of
 * the job that are genuinely expensive in attention and cheap in risk.
 *
 * Two consequences that are features, not gaps:
 *   - The Windows/AD/M365 post has the LOWEST risk ceiling in the pack,
 *     because it is the post sitting closest to Tier 0. Competence and
 *     authority are separate fields here, and this is what that separation is
 *     for.
 *   - `tier0_change` appears in `requires_approval_for` even though no tool in
 *     this pack could perform one. An owner may later grant these agents tools
 *     that this file never saw (an MCP server, a marketplace tool), and the
 *     policy has to already say the right thing when they do.
 *
 * Registration is not permission (docs/TOOLS.md): declaring a tool here only
 * makes it grantable. Nothing in this file gives an agent access to anything.
 */

import { defineBusinessPack } from "../business-pack.ts";

export const mspPack = defineBusinessPack({
  key: "msp",
  version: "1.0.0",
  label: "MSP / IT-Betrieb",
  summary:
    "Service Desk, Linux- und Virtualisierungsbetrieb, Windows/AD/M365, Netzwerk sowie Backup und Monitoring " +
    "für einen Managed-Service-Provider. Alle mitgelieferten Werkzeuge sind ausschliesslich lesend: Dieses Paket " +
    "liefert Befunde und vorbereitete Änderungen, keine Tier-0-Automatisierung.",

  // Only one new department. The five posts below are otherwise a genuine fit
  // for the seeded org chart — an MSP's Linux, Windows, network, backup and
  // monitoring people all sit in `infrastructure` ("Proxmox, Windows, Linux,
  // Netzwerk, M365, Betrieb"), and inventing an "Operations" department
  // beside it would split one team across two boxes for no operational
  // reason. A service desk is different: it is customer-facing intake with
  // its own queue, its own response times and its own escalation path, and
  // nothing seeded covers it.
  departments: [
    {
      key: "service-desk",
      name: "Service Desk",
      description: "Erstkontakt, Ticket-Annahme, Triage und 1st-Level-Support für Kundenanfragen",
      sort_order: 500,
    },
  ],

  agents: [
    {
      key: "msp-service-desk",
      department: "service-desk",
      professional_role: "service_desk_first_level",
      role_summary:
        "Erste Anlaufstelle für Kundentickets. Nimmt Störungen auf, klassifiziert nach Auswirkung und " +
        "Dringlichkeit, prüft Standardfälle gegen die Wissensdatenbank und eskaliert alles, was ein Eingriff " +
        "am Kundensystem wäre. Ändert selbst nichts an Kundensystemen und sagt dem Kunden nichts zu, was der " +
        "Betreiber nicht freigegeben hat.",
      seniority: "senior",
      runtime_profile: "balanced",
      skin: {
        display_name: "Relay",
        accent: "cyan",
        traits: ["responsive", "plain_spoken", "asks_before_assuming"],
        forbidden_traits: ["closes_tickets_without_resolution", "invents_root_causes"],
      },
      policy: {
        may_delegate: false,
        may_create_tasks: true,
        may_approve: false,
        // The intake post reads status and writes tickets. Nothing it does
        // should ever be more than low risk; if a ticket needs more, it is an
        // escalation, not a bigger ceiling.
        max_risk_level: "low",
        allowed_tools: ["task_create", "task_query", "memory_search", "agent_message", "rmm.agents", "rmm.alerts"],
        requires_approval_for: ["external_customer_commitment"],
      },
    },
    {
      key: "msp-linux-ops",
      department: "infrastructure",
      professional_role: "linux_and_virtualisation_operations",
      role_summary:
        "Betrieb von Proxmox-Clustern und Linux-Servern: Cluster- und Storage-Zustand, VM- und LXC-Bestand, " +
        "Ressourcenengpässe, Update-Stände, Fehlerbilder aus Logs. Erarbeitet Änderungen als nachvollziehbaren " +
        "Vorschlag mit Rückfallweg; ausgeführt wird nach Freigabe durch den Betreiber.",
      seniority: "lead",
      runtime_profile: "balanced",
      skin: {
        display_name: "Pylon",
        accent: "cyan",
        traits: ["methodical", "capacity_aware", "documents_findings"],
        forbidden_traits: ["improvises_on_production", "changes_without_change_record"],
      },
      policy: {
        may_delegate: false,
        may_create_tasks: true,
        may_approve: false,
        max_risk_level: "medium",
        allowed_tools: [
          "file_read",
          "shell_safe",
          "task_query",
          "memory_search",
          "proxmox.inventory",
          "proxmox.backup-status",
          "rmm.agents",
        ],
        requires_approval_for: ["production_deployment", "irreversible_data_change", "tier0_change"],
      },
    },
    {
      key: "msp-windows-ops",
      department: "infrastructure",
      professional_role: "windows_ad_and_m365_operations",
      role_summary:
        "Windows-Server, Active Directory und Microsoft 365 im Kundenbetrieb: Benutzer- und Gruppenstände, " +
        "Lizenzen, Richtlinien- und GPO-Auswertung, Fehlerbilder aus Ereignisprotokollen, Patch-Stand. " +
        "Arbeitet grundsätzlich ohne Tier-0-Rechte. Verzeichnis- und Administrationsänderungen werden " +
        "beschrieben und begründet, nicht ausgeführt.",
      seniority: "lead",
      runtime_profile: "balanced",
      skin: {
        display_name: "Bastion",
        accent: "amber",
        traits: ["precise", "tier_conscious", "evidence_driven"],
        forbidden_traits: ["requests_domain_admin", "edits_directory_objects_unattended"],
      },
      policy: {
        may_delegate: false,
        may_create_tasks: true,
        may_approve: false,
        // Lowest ceiling in the pack, on purpose. This post is the one whose
        // subject matter is Tier 0 itself, so it is the one where an
        // over-broad grant would be worth the most to an attacker. Competence
        // is `professional_role`; authority is here, and they are allowed to
        // disagree.
        max_risk_level: "low",
        allowed_tools: ["file_read", "task_query", "memory_search", "rmm.agents", "rmm.patch-status"],
        requires_approval_for: ["tier0_change", "permission_change", "production_deployment", "secret_disclosure"],
      },
    },
    {
      key: "msp-network-ops",
      department: "infrastructure",
      professional_role: "network_operations",
      role_summary:
        "Netzwerkbetrieb beim Kunden: Zustand von Switches, Access Points und Gateways, VLAN- und " +
        "Client-Zuordnung, Funkabdeckung, Uplink-Qualität sowie Auffälligkeiten wie Portfehler, " +
        "Firmware-Rückstände oder wiederkehrende Neustarts. Firewall- und Routing-Änderungen werden " +
        "vorbereitet und dokumentiert, nicht geschaltet.",
      seniority: "lead",
      runtime_profile: "balanced",
      skin: {
        display_name: "Lattice",
        accent: "cyan",
        traits: ["systematic", "topology_aware", "measures_before_claiming"],
        forbidden_traits: ["changes_firewall_rules_unattended", "guesses_topology"],
      },
      policy: {
        may_delegate: false,
        may_create_tasks: true,
        may_approve: false,
        max_risk_level: "medium",
        allowed_tools: ["file_read", "task_query", "memory_search", "unifi.devices", "unifi.clients", "rmm.alerts"],
        requires_approval_for: ["production_deployment", "tier0_change"],
      },
    },
    {
      key: "msp-backup-monitoring",
      department: "infrastructure",
      professional_role: "backup_and_monitoring_operations",
      role_summary:
        "Backup- und Monitoring-Kontrolle: prüft Sicherungsläufe, Aufbewahrung und den Nachweis getesteter " +
        "Wiederherstellungen, wertet Alarme aus Monitoring und RMM aus und meldet vor allem stille Ausfälle. " +
        "Ein Endpunkt, der sich nicht mehr meldet, und eine Sicherung, die seit Tagen nicht mehr gelaufen ist, " +
        "sind Befunde — kein grüner Zustand.",
      seniority: "senior",
      // Deep reasoning rather than balanced: the work is correlating many
      // weak signals across customers, which is exactly where a fast, shallow
      // pass reports "all green" and misses the one host that stopped
      // reporting.
      runtime_profile: "deep_reasoning",
      skin: {
        display_name: "Vigil",
        accent: "amber",
        traits: ["distrustful_of_green_dashboards", "persistent", "quantifies_gaps"],
        forbidden_traits: ["reports_success_without_evidence", "silently_ignores_stale_data"],
      },
      policy: {
        may_delegate: false,
        may_create_tasks: true,
        may_approve: false,
        max_risk_level: "low",
        allowed_tools: [
          "file_read",
          "task_query",
          "memory_search",
          "proxmox.backup-status",
          "rmm.agents",
          "rmm.alerts",
        ],
        // A restore overwrites live data. That it would be done by a human
        // does not make it a non-decision, so it is named here.
        requires_approval_for: ["irreversible_data_change", "production_deployment"],
      },
    },
  ],

  // Tool keys name the CAPABILITY, integration keys name the VENDOR
  // (`rmm.alerts` backed by `tactical-rmm`). An MSP that swaps its RMM keeps
  // every grant an owner made; a key of `tacticalrmm.alerts` would make a
  // vendor change look like a permission change to everyone downstream.
  //
  // Every one of these is `read`. See the Tier-0 note at the top of the file:
  // that is the whole design, not an oversight to be filled in later.
  tools: [
    {
      key: "proxmox.inventory",
      label: "Proxmox-Inventar",
      description:
        "Liest Knoten, VMs, Container, Storage und deren Zustand aus dem Proxmox-Cluster. Ausschliesslich lesend.",
      risk_class: "read",
      integration: "proxmox",
    },
    {
      key: "proxmox.backup-status",
      label: "Proxmox-Backup-Status",
      description:
        "Liest Sicherungsaufträge, ihre letzten Läufe, Laufzeiten und Fehlermeldungen aus Proxmox. " +
        "Ausschliesslich lesend.",
      risk_class: "read",
      integration: "proxmox",
    },
    {
      key: "rmm.agents",
      label: "RMM-Endpunkte",
      description:
        "Liest den Bestand der überwachten Endpunkte mit Betriebssystem, letzter Rückmeldung und Online-Zustand. " +
        "Ausschliesslich lesend.",
      risk_class: "read",
      integration: "tactical-rmm",
    },
    {
      key: "rmm.alerts",
      label: "RMM-Alarme",
      description:
        "Liest offene und quittierte Alarme mit Schweregrad, Endpunkt und Zeitpunkt. Ausschliesslich lesend.",
      risk_class: "read",
      integration: "tactical-rmm",
    },
    {
      key: "rmm.patch-status",
      label: "RMM-Patch-Stand",
      description: "Liest ausstehende, installierte und fehlgeschlagene Updates je Endpunkt. Ausschliesslich lesend.",
      risk_class: "read",
      integration: "tactical-rmm",
    },
    {
      key: "unifi.devices",
      label: "UniFi-Geräte",
      description:
        "Liest Switches, Access Points und Gateways mit Zustand, Uplink, Firmware-Stand und Betriebsdauer. " +
        "Ausschliesslich lesend.",
      risk_class: "read",
      integration: "unifi",
    },
    {
      key: "unifi.clients",
      label: "UniFi-Clients",
      description:
        "Liest verbundene Clients mit Netz, VLAN, Signalstärke und Verbindungsdauer. Ausschliesslich lesend.",
      risk_class: "read",
      integration: "unifi",
    },
  ],

  // Installed disabled (business-pack.ts). The instruction is what the owner
  // would have typed, because a routine creates an ordinary, visible task —
  // it does not do the work itself (docs/TOOLS.md).
  routines: [
    {
      key: "msp.morning-alert-triage",
      name: "Morgendliche Alarm-Triage",
      instruction:
        "Sieh dir alle Alarme der letzten 24 Stunden aus dem RMM und dem Monitoring an. Fasse sie nach Kunde und " +
        "Auswirkung zusammen, sortiere bekanntes Rauschen mit kurzer Begründung aus und lege für jeden Alarm, der " +
        "heute Arbeit bedeutet, eine Aufgabe mit Priorität, betroffenem System und Kunde an. Endpunkte, die sich " +
        "seit mehr als 24 Stunden nicht mehr gemeldet haben, gehören ausdrücklich in die Liste: Ein stiller Agent " +
        "ist kein grüner Agent.",
      interval_minutes: 1440,
    },
    {
      key: "msp.weekly-backup-verification",
      name: "Wöchentliche Backup-Verifikation",
      instruction:
        "Prüfe für jeden Kunden die Sicherungsläufe der letzten sieben Tage: Was ist gelaufen, was ist " +
        "fehlgeschlagen, was ist gar nicht erst gestartet, und wie alt ist die jeweils jüngste brauchbare " +
        "Sicherung. Vergleiche das mit der vereinbarten Aufbewahrung und halte fest, wann zuletzt eine " +
        "Wiederherstellung getestet wurde. Ergebnis ist ein kurzer Bericht mit einer Zeile pro Kunde und einer " +
        "klaren Liste der Lücken, jeweils mit Datum und Nachweis.",
      interval_minutes: 10080,
    },
    {
      key: "msp.monthly-patch-eol-review",
      name: "Monatlicher Patch- und EOL-Review",
      instruction:
        "Erstelle eine Übersicht des Patch-Stands aller überwachten Endpunkte und Server: fehlende und " +
        "fehlgeschlagene Updates, Systeme ohne Patch seit über 30 Tagen sowie Betriebssystem- und " +
        "Firmware-Versionen, die ihr Support-Ende erreicht haben oder es in den nächsten sechs Monaten erreichen. " +
        "Priorisiere nach Exponiertheit gegenüber dem Internet und nach Kundenauswirkung und schlage pro Fund " +
        "einen konkreten nächsten Schritt samt Rückfallweg vor.",
      interval_minutes: 43200,
    },
  ],

  // The declaration, not the adapter: this is what lets the API answer "what
  // would this pack need from me" before anyone installs it. Read-only
  // credentials are sufficient for every tool above, and an operator should
  // issue exactly that — a Proxmox token with PVEAuditor, an RMM key without
  // command rights, a UniFi key with read scope.
  integrations: [
    {
      key: "proxmox",
      label: "Proxmox VE",
      summary:
        "Cluster-, VM- und Backup-Zustand eines Proxmox-VE-Servers, gelesen über die API mit einem API-Token. " +
        "Ein Token mit ausschliesslich lesender Rolle (PVEAuditor) genügt für dieses Paket.",
      env: [{ name: "PROXMOX_URL" }, { name: "PROXMOX_TOKEN_ID" }, { name: "PROXMOX_TOKEN_SECRET" }],
      docs_url: "https://pve.proxmox.com/pve-docs/api-viewer/",
    },
    {
      key: "tactical-rmm",
      label: "Tactical RMM",
      summary:
        "Endpunkt-Bestand, Alarme und Patch-Stände aus einer selbst gehosteten Tactical-RMM-Instanz. " +
        "Der API-Schlüssel gehört zu einem Benutzer ohne Ausführungsrechte für Skripte und Befehle.",
      env: [{ name: "TACTICAL_RMM_URL" }, { name: "TACTICAL_RMM_API_KEY" }],
      docs_url: "https://docs.tacticalrmm.com/",
    },
    {
      key: "unifi",
      label: "UniFi Network",
      summary:
        "Geräte- und Client-Zustand aus einem UniFi-Network-Controller. UNIFI_SITE ist optional und bleibt ohne " +
        "Angabe auf der Standard-Site.",
      env: [{ name: "UNIFI_URL" }, { name: "UNIFI_API_KEY" }, { name: "UNIFI_SITE", optional: true }],
      docs_url: "https://developer.ui.com/unifi-api/",
    },
  ],
});
