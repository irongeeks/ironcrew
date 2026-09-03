export interface DecisionOption {
  number: number;
  label: string;
  action?: string;
}

export interface ParsedDecisionRequest {
  options: DecisionOption[];
}

const NUMBERED_OPTION_RE = /^\s*(\d{1,2})\s*[.)]?\s*(.*)$/;
const DECISION_HINT_RE = /(의사결정|진행\s*옵션|옵션|선택|방향|decision|options?|choose|proceed)/i;

export function parseDecisionRequest(content: string): ParsedDecisionRequest | null {
  if (!content) return null;
  const normalized = content.replace(/\r\n/g, "\n");
  if (!DECISION_HINT_RE.test(normalized)) return null;

  const lines = normalized.split("\n");
  const parsed: DecisionOption[] = [];
  let current: DecisionOption | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const matched = line.match(NUMBERED_OPTION_RE);
    if (matched) {
      const number = Number.parseInt(matched[1], 10);
      if (!Number.isFinite(number)) continue;
      if (current) {
        current.label = current.label.trim();
        parsed.push(current);
      }
      current = { number, label: (matched[2] ?? "").trim() };
      continue;
    }

    if (current) {
      const continuation = line.replace(/^[-*]\s+/, "").trim();
      if (continuation) {
        current.label = `${current.label} ${continuation}`.trim();
      }
    }
  }

  if (current) {
    current.label = current.label.trim();
    parsed.push(current);
  }

  const deduped = new Map<number, DecisionOption>();
  for (const option of parsed) {
    if (!option.label || deduped.has(option.number)) continue;
    deduped.set(option.number, option);
  }

  const options = Array.from(deduped.values())
    .sort((a, b) => a.number - b.number)
    .slice(0, 6);

  if (options.length < 2) return null;
  return { options };
}
