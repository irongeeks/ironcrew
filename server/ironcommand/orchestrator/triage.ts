/**
 * Iron Command OS — Executive Assistant triage.
 *
 * Classifies every CEO message and decides what happens next. This is a
 * deterministic, rule-based classifier rather than an LLM call, for three
 * reasons: it is testable, it costs nothing, and triage must keep working
 * when every runtime is rate-limited.
 *
 * A runtime-backed classifier can be layered on later behind the same
 * interface; the rules here then become the fallback rather than the only path.
 */

export const TRIAGE_CATEGORIES = [
  "question",
  "simple_task",
  "project",
  "approval_response",
  "status_request",
  "change_request",
  "incident",
  "sensitive_request",
] as const;

export type TriageCategory = (typeof TRIAGE_CATEGORIES)[number];

export interface TriageResult {
  category: TriageCategory;
  /** 0..1 — how strongly the rules matched. Low values should ask the CEO. */
  confidence: number;
  /** Which signals fired, shown in the "why was this classified so?" view. */
  signals: string[];
  riskLevel: "low" | "medium" | "high" | "critical";
  sensitive: boolean;
  /** Department key the work should go to, when derivable. */
  suggestedDepartment?: string;
  /** True when the EA should ask a clarifying question instead of acting. */
  needsClarification: boolean;
}

interface Rule {
  category: TriageCategory;
  signal: string;
  weight: number;
  test: RegExp;
}

/**
 * Normalise German text before matching.
 *
 * Two problems this solves, both of which silently broke naive \b patterns:
 *  - JavaScript's \b is defined over [A-Za-z0-9_], so "ü" is a non-word
 *    character. `\büberweis` can therefore NEVER match "überweisen", because
 *    there is no boundary between a space and "ü".
 *  - German inflects heavily ("Schwachstelle" / "Schwachstellen",
 *    "schreibe" / "schreiben"), so a trailing \b rejects the very forms a CEO
 *    actually writes.
 *
 * Folding umlauts to their ASCII digraphs and matching a word START only
 * (allowing any suffix) fixes both.
 */
export function normaliseGerman(text: string): string {
  return text.toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss");
}

/**
 * Build a regex matching any of `stems` at a word start, with any suffix.
 * Input stems must already be in normalised (ASCII, umlaut-folded) form.
 */
function stems(...list: string[]): RegExp {
  const alternation = list.join("|");
  return new RegExp(`(?:^|[^a-z0-9])(?:${alternation})`, "i");
}

const RULES: Rule[] = [
  // incident — weighted high so an outage is never filed as a question
  {
    category: "incident",
    signal: "outage_keyword",
    weight: 4,
    test: stems("ausfall", "stoerung", "notfall", "incident", "outage", "offline", "totalausfall"),
  },
  {
    category: "incident",
    signal: "breach_keyword",
    weight: 4,
    test: stems("sicherheitsvorfall", "breach", "kompromitt", "ransomware", "cyberangriff"),
  },

  // sensitive — weighted high so money and credentials are never routine
  {
    category: "sensitive_request",
    signal: "money_movement",
    weight: 4,
    test: stems("ueberweis", "ueberweisung", "zahlung", "transfer", "iban", "lastschrift", "bezahl"),
  },
  {
    category: "sensitive_request",
    signal: "tax",
    weight: 4,
    test: stems("ustva", "umsatzsteuer", "steuererklaerung", "finanzamt", "elster"),
  },
  {
    category: "sensitive_request",
    signal: "contract_signing",
    weight: 3,
    test: stems("unterschreib", "unterzeichn", "vertragsabschluss", "kuendig"),
  },
  {
    category: "sensitive_request",
    signal: "credentials",
    weight: 4,
    test: stems("passwort", "password", "api-key", "api key", "apikey", "zugangsdaten", "credential", "secret"),
  },
  {
    category: "sensitive_request",
    signal: "production",
    weight: 3,
    test: stems("produktiv", "production", "live schalten", "tier-0", "tier 0"),
  },

  // approval response — an explicit verdict, so weighted above generic words
  {
    category: "approval_response",
    signal: "approve_word",
    weight: 5,
    test: /^\s*(ja[,.]?\s*(freigabe|genehmig)|freigabe erteilt|genehmigt|freigegeben|approved?|abgelehnt|rejected?|nein[,.]?\s*(nicht|keine)\s*freigabe)/i,
  },

  // status — an explicit status word is a strong signal, above a question mark
  {
    category: "status_request",
    signal: "status_word",
    weight: 4,
    test: stems("status", "stand der dinge", "wie weit", "fortschritt", "woran arbeitet"),
  },

  // change request
  {
    category: "change_request",
    signal: "change_word",
    weight: 3,
    test: stems("aendere", "anpassen", "stoppe", "pausiere", "abbrechen", "priorisier", "verschieb", "umplanen"),
  },

  // project
  {
    category: "project",
    signal: "project_word",
    weight: 3,
    test: stems("projekt", "roadmap", "konzept", "migration", "rollout", "einfuehrung", "end-to-end"),
  },
  {
    category: "project",
    signal: "multi_deliverable",
    weight: 1,
    test: stems("und dann", "danach", "anschliessend", "schritt 1", "schritt 2"),
  },

  // question
  {
    category: "question",
    signal: "question_word",
    weight: 2,
    test: /(?:^|[^a-z0-9])(was|wie|warum|wieso|wann|wer|welche|ob)\b[^?]*\?/i,
  },
  { category: "question", signal: "trailing_question", weight: 1, test: /\?\s*$/ },

  // simple task
  {
    category: "simple_task",
    signal: "imperative",
    weight: 3,
    test: stems(
      "erstelle",
      "schreib",
      "pruefe",
      "analysier",
      "recherchier",
      "fasse zusammen",
      "dokumentier",
      "baue",
      "richte ein",
      "erzeuge",
      "liste",
    ),
  },
];

/** Keyword -> department routing. First match wins. Stems, not whole words. */
const DEPARTMENT_HINTS: Array<[RegExp, string]> = [
  [stems("sicherheit", "security", "threat", "pentest", "haertung", "schwachstelle", "firewall"), "security"],
  [stems("rechnung", "beleg", "buchhaltung", "ustva", "steuer", "zahlung", "lexware", "kasse"), "finance"],
  [stems("vertrag", "klausel", "recht", "agb", "dsgvo", "gdpr", "haftung", "nda"), "legal"],
  [
    stems(
      "proxmox",
      "server",
      "netzwerk",
      "active directory",
      "windows",
      "linux",
      "m365",
      "unifi",
      "backup",
      "rmm",
      "cluster",
    ),
    "infrastructure",
  ],
  [stems("recherche", "research", "marktanalyse", "quellen", "wettbewerb"), "research"],
  [stems("design", "ui-", "ui ", "ux", "layout", "marke", "brand", "figma"), "design"],
  [stems("marketing", "kampagne", "landingpage", "seo", "content", "copywriting"), "marketing"],
  [stems("angebot", "lead", "pipeline", "verhandl", "vertrieb", "kunde gewinnen"), "sales"],
  [stems("doku", "dokumentation", "sop", "handbuch", "wiki", "onboarding"), "knowledge"],
  [stems("mcp", "automatisier", "workflow", "integration", "webhook"), "automation"],
  [stems("test", "qa", "bug", "root cause", "regression", "fehler such"), "quality"],
  [stems("code", "software", "architektur", "api", "refactor", "repository", "deployment"), "engineering"],
];

export function suggestDepartment(text: string): string | undefined {
  const normalised = normaliseGerman(text);
  for (const [pattern, dept] of DEPARTMENT_HINTS) {
    if (pattern.test(normalised)) return dept;
  }
  return undefined;
}

/**
 * Classify a CEO message.
 *
 * Precedence is deliberate: incident and sensitive_request outrank everything
 * else, because misfiling either has a much worse cost than misfiling a
 * question.
 */
export function triage(message: string): TriageResult {
  const text = (message ?? "").trim();

  if (!text) {
    return {
      category: "question",
      confidence: 0,
      signals: [],
      riskLevel: "low",
      sensitive: false,
      needsClarification: true,
    };
  }

  const normalised = normaliseGerman(text);
  const scores = new Map<TriageCategory, number>();
  const signals: string[] = [];

  for (const rule of RULES) {
    if (rule.test.test(normalised)) {
      scores.set(rule.category, (scores.get(rule.category) ?? 0) + rule.weight);
      signals.push(rule.signal);
    }
  }

  const sensitive = (scores.get("sensitive_request") ?? 0) > 0;
  const isIncident = (scores.get("incident") ?? 0) > 0;

  let category: TriageCategory;
  let topScore: number;

  if (isIncident) {
    category = "incident";
    topScore = scores.get("incident")!;
  } else if (sensitive) {
    category = "sensitive_request";
    topScore = scores.get("sensitive_request")!;
  } else if (scores.size === 0) {
    // Nothing matched. A short message is most likely a question; a long one
    // is most likely work. Either way confidence is low.
    category = text.length > 200 ? "simple_task" : "question";
    topScore = 0;
  } else {
    const sorted = [...scores.entries()].sort((a, b) => b[1] - a[1]);
    category = sorted[0][0];
    topScore = sorted[0][1];

    // A question mark alone should not outrank a clear instruction.
    if (category === "question" && (scores.get("simple_task") ?? 0) >= topScore) {
      category = "simple_task";
    }
  }

  const riskLevel: TriageResult["riskLevel"] = isIncident
    ? "high"
    : sensitive
      ? "high"
      : category === "project"
        ? "medium"
        : "low";

  const confidence = Math.min(topScore / 4, 1);

  return {
    category,
    confidence,
    signals,
    riskLevel,
    sensitive,
    suggestedDepartment: suggestDepartment(text),
    // Ask rather than guess when the signal is genuinely weak — but never
    // stall an incident behind a clarifying question.
    needsClarification: confidence < 0.25 && !isIncident && !sensitive,
  };
}

/** Categories the EA may act on autonomously, per company policy. */
export const AUTONOMOUS_CATEGORIES: readonly TriageCategory[] = ["question", "simple_task", "status_request"];

export function mayDelegateAutonomously(result: TriageResult): boolean {
  if (result.sensitive) return false;
  if (result.needsClarification) return false;
  return AUTONOMOUS_CATEGORIES.includes(result.category);
}
