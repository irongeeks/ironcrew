/**
 * IronCrew — Finanzen (deutsches Kleinunternehmen).
 *
 * NOTHING HERE BOOKS, PAYS OR FILES ANYTHING
 *
 * Every agent in this pack prepares; the owner decides. That is not modesty
 * about what an LLM can do — it is the only shape that survives being wrong.
 * A pack that could pay an invoice would be a pack that could pay the *wrong*
 * invoice: the duplicate, the one with the changed IBAN, the one that was
 * never for this company at all. The roadmap calls the finance surface a
 * *payment approval queue* and not a payment runner for exactly that reason,
 * and THREAT_MODEL T-01 says the same thing one layer down — capability is
 * granted deliberately, never inherited from a prompt, a routine or a pack.
 * `may_approve` is a literal `false` in the schema; this file never tries to
 * work around it, and none of the tools below could act on an approval even
 * if one existed.
 *
 * Concretely, the tools this pack registers are `read` and only `read`:
 * queries against Lexware Office. There is deliberately no
 * `lexware.book_voucher`, no `lexware.send_dunning` and no payment tool.
 * Writing one would have been the easy way to look complete; the honest
 * version is that booking and paying are the owner's two irreversible acts,
 * and this pack's job is to hand them a good list before they make one.
 *
 * USTVA PREPARATION IS PREPARATION, NOT TAX ADVICE
 *
 * The quarterly agent and the quarterly routine assemble numbers — turnover
 * by rate, input tax, and the vouchers that do not fit — so that a human
 * (usually the Steuerberater) can look at them. They do not file a UStVA,
 * they do not talk to ELSTER, and they do not give tax advice. Saying so in
 * the agents' own `role_summary` matters more than saying it here, because
 * the `role_summary` is what ends up in the prompt (`buildAgentGuidance`).
 *
 * REGISTERING IS NOT GRANTING
 *
 * Installing this pack makes the Lexware tools *exist*. `ToolStore.resolve()`
 * still fails closed until the owner grants them (docs/TOOLS.md), and the
 * routines below install disabled. An installed pack changes what is
 * possible, never what is already running.
 */

import { defineBusinessPack } from "../business-pack.ts";

/**
 * The read-only Lexware Office surface, named once so the agents' policy
 * allowlists and the tool declarations cannot drift apart.
 *
 * Two naming worlds meet in `allowed_tools`: the seed's built-in posts
 * (`document_read`, `task_query`, …) and this pack's registry keys
 * (`lexware.invoice`). Both are matched by exact string in
 * `policyPermitsTool()`, so both belong in the list verbatim — inventing a
 * third spelling here would produce an allowlist that silently permits
 * nothing.
 */
const LEXWARE_READ_TOOLS = ["lexware.vouchers", "lexware.invoice"] as const;

export const financePack = defineBusinessPack({
  key: "finance-de",
  version: "1.0.0",
  label: "Finanzen (Deutschland)",
  summary:
    "Eingangsrechnungsprüfung, Forderungen und Mahnvorschläge, Belegabgleich, " +
    "Liquiditätsvorschau und UStVA-Vorbereitung — auf Basis rein lesender " +
    "Lexware-Office-Abfragen. Dieses Paket bucht nichts, zahlt nichts und meldet " +
    "nichts an: es bereitet vor, entschieden wird vom Inhaber.",

  // No own departments: the company is already seeded with `finance`
  // (config/departments.yaml, sort_order 40). A pack that redefined a seeded
  // department would be a second place where "Finanzen" is described, and the
  // copy that drifts is always the one with fewer readers.
  departments: [],

  agents: [
    {
      key: "finance-eingangsrechnung",
      department: "finance",
      professional_role: "incoming_invoice_review",
      role_summary:
        "Prüft eingehende Rechnungen: Pflichtangaben nach § 14 UStG, Rechnungs- und " +
        "Steuernummer, Steuersatz und Summenlogik, Doppeleinreichung, und vor allem " +
        "die Bankverbindung gegen die beim Lieferanten hinterlegte. Weicht eine IBAN " +
        "ab, ist das ein Befund und keine Fussnote. Meldet Abweichungen mit Beleg; " +
        "bucht nichts, gibt nichts frei, zahlt nichts.",
      seniority: "senior",
      runtime_profile: "balanced",
      skin: {
        display_name: "Assay",
        accent: "amber",
        traits: ["meticulous", "evidence_driven", "suspicious_of_changed_bank_details"],
        forbidden_traits: ["books_entries", "initiates_payments", "guesses_missing_numbers"],
      },
      policy: {
        may_delegate: false,
        may_create_tasks: true,
        may_approve: false,
        max_risk_level: "low",
        allowed_tools: ["document_read", "file_read", "task_query", "memory_search", ...LEXWARE_READ_TOOLS],
        // No tool in this pack could execute a transfer. The entry is here so
        // that a later grant of some future write tool runs into a gate that
        // already exists, instead of one somebody has to remember to add.
        requires_approval_for: ["bank_transfer"],
      },
    },
    {
      key: "finance-forderungen",
      department: "finance",
      professional_role: "receivables_and_dunning",
      role_summary:
        "Behält offene Ausgangsrechnungen im Blick, sortiert nach Fälligkeit und Betrag, " +
        "und schlägt Zahlungserinnerung oder Mahnstufe vor — mit fertigem Textentwurf, " +
        "aber ohne Versand. Ob und in welchem Ton ein Kunde gemahnt wird, ist eine " +
        "Geschäftsbeziehung und damit eine Entscheidung des Inhabers.",
      seniority: "senior",
      runtime_profile: "balanced",
      skin: {
        display_name: "Recoup",
        accent: "amber",
        traits: ["persistent", "polite_in_writing", "tracks_dates_exactly"],
        forbidden_traits: ["sends_without_approval", "threatening", "invents_late_fees"],
      },
      policy: {
        may_delegate: false,
        may_create_tasks: true,
        may_approve: false,
        max_risk_level: "low",
        allowed_tools: ["document_read", "task_query", "memory_search", ...LEXWARE_READ_TOOLS],
        // A dunning letter is a statement to a customer, so it sits behind the
        // same gate as any other outbound commitment.
        requires_approval_for: ["external_customer_commitment"],
      },
    },
    {
      key: "finance-belegabgleich",
      department: "finance",
      professional_role: "receipt_matching",
      role_summary:
        "Gleicht Belege und Zahlungen ab und benennt genau drei Sorten Lücke: Zahlung " +
        "ohne Beleg, Beleg ohne Zahlung, Betragsdifferenz. Ergebnis ist eine belegte " +
        "Liste für einen Menschen — keine Buchung, keine Zuordnung, die im System " +
        "landet.",
      seniority: "senior",
      runtime_profile: "balanced",
      skin: {
        display_name: "Tally",
        accent: "amber",
        traits: ["systematic", "complete_over_fast", "names_the_gap"],
        forbidden_traits: ["books_entries", "silently_assumes_a_match"],
      },
      policy: {
        may_delegate: false,
        may_create_tasks: true,
        may_approve: false,
        max_risk_level: "low",
        allowed_tools: ["document_read", "file_read", "task_query", "memory_search", ...LEXWARE_READ_TOOLS],
        requires_approval_for: [],
      },
    },
    {
      key: "finance-liquiditaet",
      department: "finance",
      professional_role: "cash_forecast",
      role_summary:
        "Rechnet aus offenen Eingangs- und Ausgangsrechnungen und den bekannten " +
        "Fixkosten eine Liquiditätsvorschau für die nächsten Wochen. Nennt jede " +
        "Annahme im Klartext und markiert die Vorschau als Schätzung — eine Zahl " +
        "ohne Annahme ist in einer Vorschau keine Information, sondern ein Risiko.",
      seniority: "senior",
      runtime_profile: "deep_reasoning",
      skin: {
        display_name: "Tide",
        accent: "amber",
        traits: ["states_assumptions", "conservative", "shows_the_range"],
        forbidden_traits: ["presents_estimate_as_fact", "hides_assumptions"],
      },
      policy: {
        may_delegate: false,
        may_create_tasks: true,
        may_approve: false,
        max_risk_level: "low",
        allowed_tools: ["document_read", "task_query", "memory_search", ...LEXWARE_READ_TOOLS],
        requires_approval_for: [],
      },
    },
    {
      key: "finance-ustva",
      department: "finance",
      professional_role: "vat_return_preparation",
      role_summary:
        "Bereitet die Zahlen für die Umsatzsteuer-Voranmeldung des abgelaufenen " +
        "Quartals auf: Umsätze nach Steuersatz, Vorsteuer, innergemeinschaftliche " +
        "und unklare Vorgänge getrennt ausgewiesen. Das ist eine Zuarbeit für den " +
        "Steuerberater: keine Anmeldung, keine Übermittlung an ELSTER, keine " +
        "steuerliche Beratung und keine Auslegung von Zweifelsfällen.",
      seniority: "lead",
      runtime_profile: "deep_reasoning",
      skin: {
        display_name: "Levy",
        accent: "amber",
        traits: ["exacting", "separates_unclear_cases", "documents_sources"],
        forbidden_traits: ["files_returns", "gives_tax_advice", "aggressive_tax_positions"],
      },
      policy: {
        may_delegate: false,
        may_create_tasks: true,
        may_approve: false,
        max_risk_level: "low",
        allowed_tools: ["document_read", "file_read", "task_query", "memory_search", ...LEXWARE_READ_TOOLS],
        requires_approval_for: ["tax_filing"],
      },
    },
  ],

  tools: [
    {
      key: "lexware.vouchers",
      label: "Lexware Office — Belege lesen",
      description:
        "Liest Belege und deren Status aus Lexware Office (Zeitraum, Betrag, " +
        "Kontakt, Zuordnung). Nur lesend: legt nichts an und ändert nichts.",
      risk_class: "read",
      integration: "lexware-office",
    },
    {
      key: "lexware.invoice",
      label: "Lexware Office — Rechnungen lesen",
      description:
        "Liest Eingangs- und Ausgangsrechnungen samt Fälligkeit und Zahlstatus. " +
        "Nur lesend: verschickt nichts, mahnt nicht und bucht keine Zahlung.",
      risk_class: "read",
      integration: "lexware-office",
    },
  ],

  routines: [
    {
      // Daily, because "overdue" changes daily and a sweep that runs weekly
      // finds a receivable that has been ignorable for six days already.
      key: "finance-offene-posten-taeglich",
      name: "Offene Posten prüfen (täglich)",
      instruction:
        "Sieh nach, welche Ausgangsrechnungen überfällig sind. Liste sie mit Kunde, " +
        "Betrag, Rechnungsdatum, Fälligkeit und Tagen über Fälligkeit auf, die " +
        "ältesten zuerst, und schreib mir bei jeder dazu, ob du eine " +
        "Zahlungserinnerung oder eine Mahnstufe für angemessen hältst und warum. " +
        "Entwürfe darfst du gleich mitschicken. Verschick nichts und buch nichts — " +
        "ich entscheide, was rausgeht.",
      interval_minutes: 1440,
    },
    {
      // Monthly: receipt matching against a half-finished month produces
      // "missing" entries that are merely not yet posted, and a list that is
      // wrong the first three times is a list nobody opens the fourth.
      key: "finance-belegabgleich-monatlich",
      name: "Belegabgleich (monatlich)",
      instruction:
        "Gleich die Belege des abgelaufenen Monats mit den Zahlungen ab. Sag mir " +
        "getrennt: welche Zahlungen keinen Beleg haben, welche Belege zu keiner " +
        "Zahlung passen und wo die Beträge auseinandergehen. Sortiert nach Betrag, " +
        "absteigend, mit Belegnummer und Datum. Nichts buchen, nichts zuordnen, " +
        "nichts in Lexware ändern — ich will nur die Liste.",
      interval_minutes: 43200,
    },
    {
      // ~90 days. Intervals are minutes, not cron (docs/TOOLS.md), so
      // "quarterly" is an interval and the exact filing date stays a human's
      // calendar problem — which is the honest split, because the deadline
      // belongs to the Steuerberater, not to this timer.
      key: "finance-ustva-quartal",
      name: "UStVA vorbereiten (quartalsweise)",
      instruction:
        "Stell die Zahlen für die UStVA des abgelaufenen Quartals zusammen: Umsätze " +
        "nach Steuersatz, Vorsteuer, innergemeinschaftliche Vorgänge, Reverse-Charge " +
        "und alles, was du nicht eindeutig zuordnen kannst, in einer eigenen Liste. " +
        "Nenn zu jeder Summe die Belege, aus denen sie kommt. Das ist eine " +
        "Vorbereitung für meinen Steuerberater — keine Anmeldung, keine Übermittlung " +
        "und keine steuerliche Beratung.",
      interval_minutes: 129600,
    },
  ],

  integrations: [
    {
      key: "lexware-office",
      label: "Lexware Office",
      summary:
        "Buchhaltung: Belege, Eingangs- und Ausgangsrechnungen. Dieses Paket nutzt " +
        "ausschliesslich lesende Abfragen.",
      env: [
        { name: "LEXWARE_OFFICE_API_KEY", optional: false },
        // Optional because the SaaS endpoint is the normal case; the variable
        // exists for an on-premise or proxied instance.
        { name: "LEXWARE_OFFICE_URL", optional: true },
      ],
      // No docs_url on purpose: the product was renamed from lexoffice, the
      // developer portal moved with it, and a URL guessed from memory is worse
      // than none — an operator following a dead link learns nothing, while an
      // absent link at least says "look it up".
    },
  ],
});
