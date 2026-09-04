import { execFileSync } from "node:child_process";
import type { RuntimeContext } from "../../../types/runtime-context.ts";
import type { CliUsageEntry } from "../../workflow/agents/providers/types.ts";
import { logger } from "../../../observability/logger.ts";

const log = logger.child({ module: "ops" });

export function registerWorktreeAndUsageRoutes(ctx: RuntimeContext): {
  refreshCliUsageData: () => Promise<Record<string, CliUsageEntry>>;
} {
  const {
    app,
    taskWorktrees,
    mergeWorktree,
    cleanupWorktree,
    appendTaskLog,
    resolveLang,
    pickL,
    l,
    notifyCeo,
    db,
    nowMs,
    CLI_TOOLS,
    fetchClaudeUsage,
    fetchCodexUsage,
    fetchGeminiUsage,
    broadcast,
  } = ctx;

  app.get("/api/tasks/:id/diff", (req, res) => {
    const id = String(req.params.id);
    const wtInfo = taskWorktrees.get(id);
    if (!wtInfo) {
      return res.json({ ok: true, hasWorktree: false, diff: "", stat: "" });
    }

    try {
      const currentBranch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: wtInfo.projectPath,
        stdio: "pipe",
        timeout: 5000,
      })
        .toString()
        .trim();

      const stat = execFileSync("git", ["diff", `${currentBranch}...${wtInfo.branchName}`, "--stat"], {
        cwd: wtInfo.projectPath,
        stdio: "pipe",
        timeout: 10000,
      })
        .toString()
        .trim();

      const diff = execFileSync("git", ["diff", `${currentBranch}...${wtInfo.branchName}`], {
        cwd: wtInfo.projectPath,
        stdio: "pipe",
        timeout: 15000,
      }).toString();

      res.json({
        ok: true,
        hasWorktree: true,
        branchName: wtInfo.branchName,
        stat,
        diff: diff.length > 50000 ? diff.slice(0, 50000) + "\n... (truncated)" : diff,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.json({ ok: false, error: msg });
    }
  });

  app.post("/api/tasks/:id/merge", (req, res) => {
    const id = String(req.params.id);
    const wtInfo = taskWorktrees.get(id);
    if (!wtInfo) {
      return res.status(404).json({ error: "no_worktree", message: "No worktree found for this task" });
    }

    const task = db.prepare("SELECT status FROM tasks WHERE id = ?").get(id) as { status: string } | undefined;
    if (!task) {
      return res.status(404).json({ error: "task_not_found" });
    }
    if (task.status !== "review" && task.status !== "done") {
      return res.status(409).json({
        error: "merge_not_approved",
        message: "Task must be in review or done status before merging",
      });
    }

    const result = mergeWorktree(wtInfo.projectPath, id);
    const lang = resolveLang();

    if (result.success) {
      cleanupWorktree(wtInfo.projectPath, id);
      appendTaskLog(id, "system", `Manual merge completed: ${result.message}`);
      notifyCeo(
        pickL(
          l(
            [`수동 병합 완료: ${result.message}`],
            [`Manual merge completed: ${result.message}`],
            [`手動マージ完了: ${result.message}`],
            [`手动合并完成: ${result.message}`],
          ),
          lang,
        ),
        id,
      );
    } else {
      appendTaskLog(id, "system", `Manual merge failed: ${result.message}`);
    }

    res.json({ ok: result.success, message: result.message, conflicts: result.conflicts });
  });

  app.post("/api/tasks/:id/discard", (req, res) => {
    const id = String(req.params.id);
    const wtInfo = taskWorktrees.get(id);
    if (!wtInfo) {
      return res.status(404).json({ error: "no_worktree", message: "No worktree found for this task" });
    }

    const task = db.prepare("SELECT status FROM tasks WHERE id = ?").get(id) as { status: string } | undefined;
    if (!task) {
      return res.status(404).json({ error: "task_not_found" });
    }
    if (task.status === "in_progress" || task.status === "collaborating") {
      return res.status(409).json({
        error: "task_is_active",
        message: "Stop the task before discarding its worktree",
      });
    }

    cleanupWorktree(wtInfo.projectPath, id);
    appendTaskLog(id, "system", "Worktree discarded (changes abandoned)");
    const lang = resolveLang();
    notifyCeo(
      pickL(
        l(
          [`작업 브랜치가 폐기되었습니다: ${wtInfo.branchName}`],
          [`Task branch discarded: ${wtInfo.branchName}`],
          [`タスクブランチを破棄しました: ${wtInfo.branchName}`],
          [`任务分支已丢弃: ${wtInfo.branchName}`],
        ),
        lang,
      ),
      id,
    );

    res.json({ ok: true, message: "Worktree discarded" });
  });

  app.get("/api/worktrees", (_req, res) => {
    const entries: Array<{ taskId: string; branchName: string; worktreePath: string; projectPath: string }> = [];
    for (const [taskId, info] of taskWorktrees) {
      entries.push({ taskId, ...info });
    }
    res.json({ ok: true, worktrees: entries });
  });

  function readCliUsageFromDb(): Record<string, CliUsageEntry> {
    const rows = db.prepare("SELECT provider, data_json FROM cli_usage_cache").all() as Array<{
      provider: string;
      data_json: string;
    }>;
    const usage: Record<string, CliUsageEntry> = {};
    for (const row of rows) {
      try {
        usage[row.provider] = JSON.parse(row.data_json);
      } catch {
        // invalid json row
      }
    }
    return usage;
  }

  async function refreshCliUsageData(): Promise<Record<string, CliUsageEntry>> {
    const providers = ["claude", "codex", "gemini", "copilot", "antigravity"];
    const usage: Record<string, CliUsageEntry> = {};

    const fetchMap: Record<string, () => Promise<CliUsageEntry>> = {
      claude: fetchClaudeUsage,
      codex: fetchCodexUsage,
      gemini: fetchGeminiUsage,
    };

    const fetches = providers.map(async (p) => {
      const tool = CLI_TOOLS.find((t) => t.name === p);
      if (!tool) {
        usage[p] = { windows: [], error: "not_implemented" };
        return;
      }
      if (!tool.checkAuth()) {
        usage[p] = { windows: [], error: "unauthenticated" };
        return;
      }
      const fetcher = fetchMap[p];
      if (fetcher) {
        try {
          usage[p] = await fetcher();
        } catch (err) {
          log.error({ err, provider: p }, "usage fetch failed");
          usage[p] = { windows: [], error: "fetch_failed" };
        }
      } else {
        usage[p] = { windows: [], error: "not_implemented" };
      }
    });

    await Promise.all(fetches);

    const upsert = db.prepare(
      "INSERT INTO cli_usage_cache (provider, data_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(provider) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at",
    );
    const now = nowMs();
    for (const [p, entry] of Object.entries(usage)) {
      upsert.run(p, JSON.stringify(entry), now);
    }

    return usage;
  }

  app.get("/api/cli-usage", async (_req, res) => {
    let usage = readCliUsageFromDb();
    if (Object.keys(usage).length === 0) {
      usage = await refreshCliUsageData();
    }
    res.json({ ok: true, usage });
  });

  app.post("/api/cli-usage/refresh", async (_req, res) => {
    try {
      const usage = await refreshCliUsageData();
      broadcast("cli_usage_update", usage);
      res.json({ ok: true, usage });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e) });
    }
  });

  return { refreshCliUsageData };
}
