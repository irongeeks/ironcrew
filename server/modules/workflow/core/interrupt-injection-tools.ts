import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";

type DbLike = Pick<DatabaseSync, "prepare">;

const MAX_INTERRUPT_PROMPT_CHARS = 4000;
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_REGEX = /\u001b(?:\[[0-?]*[ -/]*[@-~]|][^\u0007]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_REGEX = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const TEMPLATE_BREAKOUT_PATTERNS = [
  /<\/?(system|assistant|developer|tool)>/i,
  /<\|(?:system|assistant|developer|tool)[^|]*\|>/i,
];
const COMMAND_INJECTION_PATTERNS = [
  /(?:^|\n)\s*```(?:bash|sh|zsh|cmd|powershell|pwsh)\b/i,
  /\b(?:curl|wget)\b[^\n]*\|\s*(?:sh|bash|zsh|pwsh|powershell)\b/i,
];

export type TaskInterruptInjectionRow = {
  id: number;
  task_id: string;
  session_id: string;
  prompt_text: string;
  prompt_hash: string;
  created_at: number;
};

export function sanitizeInterruptPrompt(input: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof input !== "string") return { ok: false, error: "prompt_required" };
  const normalized = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(ANSI_ESCAPE_REGEX, "").trim();
  if (!normalized) return { ok: false, error: "prompt_required" };
  if (normalized.length > MAX_INTERRUPT_PROMPT_CHARS) return { ok: false, error: "prompt_too_long" };
  if (CONTROL_CHAR_REGEX.test(normalized)) return { ok: false, error: "prompt_control_chars_blocked" };
  if (TEMPLATE_BREAKOUT_PATTERNS.some((re) => re.test(normalized))) {
    return { ok: false, error: "prompt_template_breakout_blocked" };
  }
  if (COMMAND_INJECTION_PATTERNS.some((re) => re.test(normalized))) {
    return { ok: false, error: "prompt_command_injection_blocked" };
  }
  return { ok: true, value: normalized };
}

export function hashInterruptPrompt(prompt: string): string {
  return createHash("sha256").update(prompt, "utf8").digest("hex");
}

export function queueInterruptPrompt(
  db: DbLike,
  input: {
    taskId: string;
    sessionId: string;
    promptText: string;
    promptHash: string;
    actorTokenHash: string | null;
    now: number;
  },
): number {
  const result = db
    .prepare(
      `
      INSERT INTO task_interrupt_injections
        (task_id, session_id, prompt_text, prompt_hash, actor_token_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
    )
    .run(input.taskId, input.sessionId, input.promptText, input.promptHash, input.actorTokenHash, input.now) as {
    lastInsertRowid: number | bigint;
  };
  const rowid = result?.lastInsertRowid;
  return typeof rowid === "bigint" ? Number(rowid) : Number(rowid ?? 0);
}

export function loadPendingInterruptPrompts(
  db: DbLike,
  taskId: string,
  sessionId: string,
  limit = 5,
): TaskInterruptInjectionRow[] {
  return db
    .prepare(
      `
      SELECT id, task_id, session_id, prompt_text, prompt_hash, created_at
      FROM task_interrupt_injections
      WHERE task_id = ?
        AND session_id = ?
        AND consumed_at IS NULL
      ORDER BY created_at ASC, id ASC
      LIMIT ?
    `,
    )
    .all(taskId, sessionId, Math.max(1, Math.min(limit, 10))) as TaskInterruptInjectionRow[];
}

export function consumeInterruptPrompts(db: DbLike, ids: number[], consumedAt: number): void {
  if (ids.length === 0) return;
  const stmt = db.prepare("UPDATE task_interrupt_injections SET consumed_at = ? WHERE id = ?");
  for (const id of ids) {
    stmt.run(consumedAt, id);
  }
}

export function buildInterruptPromptBlock(rows: TaskInterruptInjectionRow[]): string {
  if (rows.length === 0) return "";
  const sections = rows.map(
    (row, idx) =>
      `[Injected Prompt ${idx + 1}] (sha256=${row.prompt_hash.slice(0, 12)}, queued_at=${row.created_at})\n${row.prompt_text}`,
  );
  return `[Interrupt Prompt Queue]\n${sections.join("\n\n")}`;
}
