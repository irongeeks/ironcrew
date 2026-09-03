import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { RuntimeContext } from "../../../../types/runtime-context.ts";

const REPORT_DOC_TEXT_LIMIT = 120_000;
const REPORT_PREVIEW_LIMIT = 260;
const TEXT_DOC_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".json",
  ".yml",
  ".yaml",
  ".csv",
  ".log",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".css",
  ".html",
  ".xml",
  ".sql",
]);
const BINARY_DOC_EXTENSIONS = new Set([".pdf", ".ppt", ".pptx", ".doc", ".docx"]);

type HelperDeps = {
  db: RuntimeContext["db"];
  nowMs: RuntimeContext["nowMs"];
};

export function createTaskReportHelpers(deps: HelperDeps) {
  const { db } = deps;

  function normalizeTaskText(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
  }

  function buildTextPreview(content: string, maxChars = REPORT_PREVIEW_LIMIT): string {
    const normalized = content.replace(/\s+/g, " ").trim();
    if (normalized.length <= maxChars) return normalized;
    return `${normalized.slice(0, maxChars).trimEnd()}...`;
  }

  function normalizeProjectName(projectPath: unknown, fallbackTitle = "General"): string {
    const p = normalizeTaskText(projectPath);
    if (!p) return fallbackTitle;
    try {
      const normalized = p.replace(/[\\/]+$/, "");
      const name = path.basename(normalized);
      return name || fallbackTitle;
    } catch {
      return fallbackTitle;
    }
  }

  function extractTargetFilePath(description: unknown): string | null {
    const desc = normalizeTaskText(description);
    if (!desc) return null;
    const m = desc.match(/target file path:\s*(.+)/i);
    if (!m?.[1]) return null;
    return m[1].trim().replace(/^['"`]|['"`]$/g, "");
  }

  function extractDocumentPathCandidates(texts: string[]): string[] {
    const out = new Set<string>();
    const pattern = /(?:[A-Za-z]:\\|\/)?[^\s"'`<>|]+?\.(?:md|markdown|txt|json|ya?ml|csv|log|html?|pdf|pptx?|docx?)/gi;
    for (const rawText of texts) {
      if (!rawText) continue;
      const matches = rawText.match(pattern) ?? [];
      for (const m of matches) {
        const cleaned = m.replace(/[),.;:]+$/g, "").trim();
        if (cleaned.length > 1) out.add(cleaned);
      }
    }
    return [...out];
  }

  function resolveDocumentPath(candidate: string, projectPath: string | null): string {
    if (path.isAbsolute(candidate)) return candidate;
    if (projectPath) return path.resolve(projectPath, candidate);
    return path.resolve(process.cwd(), candidate);
  }

  function readReportDocument(pathCandidate: string, projectPath: string | null): Record<string, unknown> | null {
    try {
      const absPath = resolveDocumentPath(pathCandidate, projectPath);
      if (!fs.existsSync(absPath)) return null;
      const stat = fs.statSync(absPath);
      if (!stat.isFile()) return null;

      const ext = path.extname(absPath).toLowerCase();
      const rel = path.relative(process.cwd(), absPath).replace(/\\/g, "/");
      const docId = `file:${rel}`;

      if (BINARY_DOC_EXTENSIONS.has(ext)) {
        return {
          id: docId,
          title: path.basename(absPath),
          source: "file",
          path: rel,
          mime:
            ext === ".pdf"
              ? "application/pdf"
              : ext === ".ppt" || ext === ".pptx"
                ? "application/vnd.openxmlformats-officedocument.presentationml.presentation"
                : "application/octet-stream",
          size_bytes: stat.size,
          updated_at: stat.mtimeMs,
          truncated: false,
          text_preview: `Binary document generated: ${rel}`,
          content: `Binary document generated at ${rel} (${Math.round(stat.size / 1024)} KB).`,
        };
      }

      if (!TEXT_DOC_EXTENSIONS.has(ext) && stat.size > 512_000) {
        return null;
      }

      const raw = fs.readFileSync(absPath, "utf8");
      const truncated = raw.length > REPORT_DOC_TEXT_LIMIT;
      const content = truncated ? `${raw.slice(0, REPORT_DOC_TEXT_LIMIT)}\n\n...[truncated]` : raw;
      return {
        id: docId,
        title: path.basename(absPath),
        source: "file",
        path: rel,
        mime: "text/plain",
        size_bytes: stat.size,
        updated_at: stat.mtimeMs,
        truncated,
        text_preview: buildTextPreview(content),
        content,
      };
    } catch {
      return null;
    }
  }

  function documentPriority(doc: Record<string, unknown>): number {
    const joined = `${normalizeTaskText(doc.path)} ${normalizeTaskText(doc.title)}`.toLowerCase();
    if (/\.(md|markdown)\b/.test(joined)) return 0;
    const source = normalizeTaskText(doc.source);
    if (source === "file") return 1;
    if (source === "report_message") return 2;
    if (source === "task_result") return 3;
    return 4;
  }

  function sortReportDocuments(docs: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
    return [...docs].sort((a, b) => {
      const pa = documentPriority(a);
      const pb = documentPriority(b);
      if (pa !== pb) return pa - pb;
      const ua = Number(a.updated_at ?? 0) || 0;
      const ub = Number(b.updated_at ?? 0) || 0;
      if (ua !== ub) return ub - ua;
      return normalizeTaskText(a.title).localeCompare(normalizeTaskText(b.title));
    });
  }

  function fetchMeetingMinutesForTask(taskId: string): Array<Record<string, unknown>> {
    return db
      .prepare(
        `
    SELECT
      mm.meeting_type,
      mm.round AS round_number,
      COALESCE((
        SELECT group_concat(entry_line, '\n')
        FROM (
          SELECT printf('[%s] %s', COALESCE(e.speaker_name, 'Unknown'), e.content) AS entry_line
          FROM meeting_minute_entries e
          WHERE e.meeting_id = mm.id
          ORDER BY e.seq ASC, e.id ASC
        )
      ), '') AS entries,
      mm.created_at
    FROM meeting_minutes mm
    WHERE mm.task_id = ?
    ORDER BY mm.created_at ASC
  `,
      )
      .all(taskId) as Array<Record<string, unknown>>;
  }

  function fetchReportMessages(taskId: string): Array<Record<string, unknown>> {
    return db
      .prepare(
        `
    SELECT m.id, m.content, m.created_at, m.sender_id,
           COALESCE(a.name, '') AS sender_name,
           COALESCE(a.name_ko, '') AS sender_name_ko,
           COALESCE(a.department_id, '') AS sender_department_id,
           COALESCE(d.name, '') AS sender_department_name,
           COALESCE(d.name_ko, '') AS sender_department_name_ko
    FROM messages m
    LEFT JOIN agents a ON a.id = m.sender_id
    LEFT JOIN departments d ON d.id = a.department_id
    WHERE m.task_id = ? AND m.message_type = 'report'
    ORDER BY m.created_at DESC
  `,
      )
      .all(taskId) as Array<Record<string, unknown>>;
  }

  function buildTaskSection(
    taskRow: Record<string, unknown>,
    linkedSubtasks: Array<Record<string, unknown>>,
  ): Record<string, unknown> {
    const taskId = String(taskRow.id ?? "");
    const taskLogs = db
      .prepare("SELECT kind, message, created_at FROM task_logs WHERE task_id = ? ORDER BY created_at ASC")
      .all(taskId) as Array<{ kind: string; message: string; created_at: number }>;
    const taskMinutes = fetchMeetingMinutesForTask(taskId);
    const reportMessages = fetchReportMessages(taskId);
    const taskResult = normalizeTaskText(taskRow.result);
    const docs: Array<Record<string, unknown>> = [];

    const addTextDocument = (
      id: string,
      title: string,
      source: string,
      contentRaw: string,
      createdAt: number | null,
    ) => {
      const content = contentRaw.trim();
      if (!content) return;
      const truncated = content.length > REPORT_DOC_TEXT_LIMIT;
      const trimmed = truncated ? `${content.slice(0, REPORT_DOC_TEXT_LIMIT)}\n\n...[truncated]` : content;
      docs.push({
        id,
        title,
        source,
        path: null,
        mime: "text/plain",
        size_bytes: null,
        updated_at: createdAt,
        truncated,
        text_preview: buildTextPreview(trimmed),
        content: trimmed,
      });
    };

    if (taskResult) {
      addTextDocument(
        `result:${taskId}`,
        "Execution Result",
        "task_result",
        taskResult,
        Number(taskRow.completed_at ?? 0) || null,
      );
    }

    for (const msg of reportMessages.slice(0, 6)) {
      const content = normalizeTaskText(msg.content);
      if (!content) continue;
      const msgId = String(msg.id ?? randomUUID());
      const senderName = normalizeTaskText(msg.sender_name) || "Agent";
      addTextDocument(
        `report-msg:${msgId}`,
        `Report by ${senderName}`,
        "report_message",
        content,
        Number(msg.created_at ?? 0) || null,
      );
    }

    const targetFile = extractTargetFilePath(taskRow.description);
    const pathCandidates = new Set<string>();
    if (targetFile) pathCandidates.add(targetFile);
    for (const c of extractDocumentPathCandidates([
      normalizeTaskText(taskRow.description),
      taskResult,
      ...reportMessages.slice(0, 6).map((m) => normalizeTaskText(m.content)),
      ...taskLogs.slice(-8).map((l) => normalizeTaskText(l.message)),
    ])) {
      pathCandidates.add(c);
    }
    for (const candidate of pathCandidates) {
      const doc = readReportDocument(candidate, normalizeTaskText(taskRow.project_path) || null);
      if (doc) docs.push(doc);
    }

    const latestReportContent = normalizeTaskText(reportMessages[0]?.content);
    const fallbackSummary =
      latestReportContent ||
      buildTextPreview(taskResult, 400) ||
      buildTextPreview(normalizeTaskText(taskLogs[taskLogs.length - 1]?.message), 400);

    return {
      id: taskId,
      task_id: taskId,
      source_task_id: taskRow.source_task_id ?? null,
      title: taskRow.title ?? "",
      status: taskRow.status ?? "",
      department_id: taskRow.department_id ?? null,
      department_name: taskRow.dept_name ?? "",
      department_name_ko: taskRow.dept_name_ko ?? "",
      agent_id: taskRow.assigned_agent_id ?? null,
      agent_name: taskRow.agent_name ?? "",
      agent_name_ko: taskRow.agent_name_ko ?? "",
      agent_role: taskRow.agent_role ?? "",
      created_at: Number(taskRow.created_at ?? 0) || 0,
      started_at: Number(taskRow.started_at ?? 0) || null,
      completed_at: Number(taskRow.completed_at ?? 0) || null,
      summary: fallbackSummary,
      report_messages: reportMessages,
      logs: taskLogs,
      meeting_minutes: taskMinutes,
      documents: sortReportDocuments(docs),
      linked_subtasks: linkedSubtasks,
    };
  }

  return {
    normalizeTaskText,
    buildTextPreview,
    normalizeProjectName,
    sortReportDocuments,
    fetchMeetingMinutesForTask,
    buildTaskSection,
  };
}
