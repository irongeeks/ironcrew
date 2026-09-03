import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname, normalize, resolve as pathResolve, sep } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { LoadedPack } from "../../../packs/pack-loader.ts";
import type { Phase, PhaseOutput } from "../../../packs/pack-schema.ts";
import type { ConnectorRegistry } from "../../../connectors/registry.ts";
import type { Tracer } from "../../../observability/tracer.ts";
import type { MetricsCollector } from "../../../observability/metrics.ts";
import type { NodeTypeRegistry } from "../../../node-types/node-type-registry.ts";
import type { NodeExecuteContext } from "../../../node-types/node-type-interface.ts";
import { logger } from "../../../observability/logger.ts";
import { notifyPhaseApprovalNeeded } from "../../../gateway/client.ts";
import { parseInputRef } from "../../../packs/graph-builder.ts";
import { bridgeArtifactsForPhase, resolveArtifactRef } from "./artifact-bridge.ts";
import { createTaskPhaseLock } from "./phase-lock.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------------------------------------------------------------------
// SQL helpers
// ---------------------------------------------------------------------------

/** Escape SQL LIKE metacharacters for safe pattern matching. Use with ESCAPE '\\'. */
export function escapeLikePattern(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

// ---------------------------------------------------------------------------
// Security helpers
// ---------------------------------------------------------------------------

/** Validate that a hook path does not escape the pack directory. */
export function isHookPathSafe(hookPath: string): boolean {
  if (hookPath.startsWith("/")) return false;
  const decoded = decodeURIComponent(hookPath);
  const normalized = normalize(decoded);
  if (normalized.startsWith("..") || normalized.includes("/../") || normalized.includes("\\..\\")) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Database {
  run(sql: string, ...params: unknown[]): unknown;
  get(sql: string, ...params: unknown[]): unknown;
  all(sql: string, ...params: unknown[]): unknown;
  /** Execute raw SQL (used for BEGIN/COMMIT/ROLLBACK). */
  exec?(sql: string): void;
}

// ---------------------------------------------------------------------------
// Adapter: wrap node:sqlite DatabaseSync → graph-runner Database interface
// ---------------------------------------------------------------------------

/**
 * Wraps a `node:sqlite` DatabaseSync instance (which uses `prepare(sql).run(…)`)
 * into the simplified `Database` interface expected by GraphRunner and
 * bridgeArtifactsForPhase (`db.run(sql, …)` / `db.get(sql, …)` / `db.all(sql, …)`).
 */
export function wrapDatabaseSync(realDb: {
  exec?(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown;
  };
}): Database {
  return {
    run(sql: string, ...params: unknown[]) {
      return realDb.prepare(sql).run(...params);
    },
    get(sql: string, ...params: unknown[]) {
      return realDb.prepare(sql).get(...params);
    },
    all(sql: string, ...params: unknown[]) {
      return realDb.prepare(sql).all(...params);
    },
    exec: realDb.exec?.bind(realDb),
  };
}

interface SubtaskRow {
  id: string;
  task_id: string;
  title: string;
  description: string;
  status: string;
}

export interface PhaseCompleteResult {
  advanced: boolean;
  nextPhases: string[];
  taskDone: boolean;
}

// ---------------------------------------------------------------------------
// GraphRunner
// ---------------------------------------------------------------------------

export class GraphRunner {
  /** Per-task trace state: taskId → { traceId, rootSpanId, phaseSpans } */
  private traceState = new Map<
    string,
    { traceId: string; rootSpanId: string; packKey: string; phaseSpans: Map<string, string> }
  >();

  /** Serializes concurrent onPhaseComplete calls per taskId to prevent race conditions. */
  private phaseLock = createTaskPhaseLock();

  /** Tracks which tasks currently have an open transaction to prevent nested BEGIN. */
  private _inTransaction = new Set<string>();

  private broadcastFn?: (event: string, payload: unknown) => void;

  constructor(
    private connectorRegistry?: ConnectorRegistry,
    private tracer?: Tracer,
    private metrics?: MetricsCollector,
    private nodeTypeRegistry?: NodeTypeRegistry,
  ) {}

  /** Wire in a broadcast function after construction (avoids circular dep at startup). */
  setBroadcast(fn: (event: string, payload: unknown) => void): void {
    this.broadcastFn = fn;
  }

  // =========================================================================
  // seedSubtasks
  // =========================================================================

  async seedSubtasks(
    db: Database,
    taskId: string,
    pack: LoadedPack,
    taskInput: Record<string, unknown>,
  ): Promise<void> {
    // Start workflow trace
    if (this.tracer) {
      const traceId = this.tracer.startTrace(taskId, pack.key);
      const rootSpanId = this.tracer.startSpan(traceId, `workflow:${pack.key}`, "system", undefined, {
        taskId,
        packKey: pack.key,
      });
      this.traceState.set(taskId, { traceId, rootSpanId, packKey: pack.key, phaseSpans: new Map() });
    }
    this.metrics?.incCounter("workflow.started", { pack: pack.key });

    const { phases, roots } = pack.graph;
    const rootSet = new Set(roots);
    const now = Date.now();

    // Load skipped phases from task record
    let skippedSet = new Set<string>();
    try {
      const task = db.get("SELECT skipped_phases FROM tasks WHERE id = ?", taskId) as
        | { skipped_phases: string }
        | undefined;
      if (task?.skipped_phases) {
        const parsed = JSON.parse(task.skipped_phases);
        if (Array.isArray(parsed)) {
          skippedSet = new Set(parsed);
        }
      }
    } catch (err) {
      logger.debug(
        { err, taskId, operation: "parse_skipped_phases" },
        "no skipped_phases or invalid JSON — proceeding without",
      );
    }

    // Build dependency map: phaseId → set of phase IDs it depends on
    const depsOf = new Map<string, Set<string>>();
    for (const phase of phases) {
      depsOf.set(phase.id, new Set());
    }
    const reverseAdj = pack.graph.reverseAdjacency;
    if (reverseAdj) {
      for (const [phaseId, upstreams] of reverseAdj) {
        const deps = depsOf.get(phaseId);
        if (deps) {
          for (const up of upstreams) {
            deps.add(up);
          }
        }
      }
    }

    for (const phase of phases) {
      const isSkipped = skippedSet.has(phase.id);

      if (isSkipped) {
        const id = randomUUID();
        db.run(
          "INSERT INTO subtasks (id, task_id, title, description, status, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          id,
          taskId,
          `[pipeline:${phase.id}]`,
          `Phase: ${phase.id} (skipped by user)`,
          "skipped",
          now,
        );
        continue;
      }

      // Determine status: pending if root OR if all dependencies are skipped
      const deps = depsOf.get(phase.id) ?? new Set();
      const allDepsSkipped = deps.size > 0 && [...deps].every((d) => skippedSet.has(d));
      const isRoot = rootSet.has(phase.id);
      const status = isRoot || allDepsSkipped ? "pending" : "blocked";

      const title = `[pipeline:${phase.id}]`;

      // Build description: inject pack input for root phases and phases promoted to pending
      let description = `Phase: ${phase.id}`;
      if (isRoot || allDepsSkipped) {
        const inputParts = this.resolvePackInputs(phase, taskInput);
        if (inputParts.length > 0) {
          description += "\n\n--- Pack Input ---\n" + inputParts.join("\n");
        }
      }

      const id = randomUUID();
      db.run(
        "INSERT INTO subtasks (id, task_id, title, description, status, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        id,
        taskId,
        title,
        description,
        status,
        now,
      );
    }

    // Store full task input as a metadata subtask for later retrieval (skip_when, etc.)
    if (Object.keys(taskInput).length > 0) {
      db.run(
        "INSERT INTO subtasks (id, task_id, title, description, status, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        randomUUID(),
        taskId,
        "[pipeline:__input__]",
        JSON.stringify(taskInput),
        "done",
        now,
      );
    }
  }

  // =========================================================================
  // onPhaseComplete
  // =========================================================================

  async onPhaseComplete(
    db: Database,
    taskId: string,
    completedPhaseId: string,
    pack: LoadedPack,
    rootDir: string,
    options?: { approved?: boolean },
  ): Promise<PhaseCompleteResult> {
    try {
      return await this.phaseLock.acquire(taskId, () =>
        this._onPhaseComplete(db, taskId, completedPhaseId, pack, rootDir, options),
      );
    } catch (err) {
      // Prevent trace-state memory leak on unrecoverable errors.
      // The caller (run-complete-handler) also calls cleanupTask on failure,
      // but this catch ensures cleanup even for unexpected code paths.
      this.cleanupTask(taskId);
      throw err;
    }
  }

  // =========================================================================
  // dispatchAutoPhases
  // =========================================================================

  /**
   * Auto-dispatch any pending phases whose `node_type` is set and whose
   * upstream dependencies are all complete.  Called by execution-run.ts
   * right after seedSubtasks() so that root node-type phases are executed
   * without requiring an agent run.
   *
   * Iterates until no further auto-dispatchable phase is found (handles
   * chains of back-to-back node-type phases).
   */
  async dispatchAutoPhases(
    db: Database,
    taskId: string,
    pack: LoadedPack,
    rootDir: string,
  ): Promise<{ dispatched: string[]; taskDone: boolean }> {
    return this.phaseLock.acquire(taskId, () => this._dispatchAutoPhases(db, taskId, pack, rootDir));
  }

  private async _dispatchAutoPhases(
    db: Database,
    taskId: string,
    pack: LoadedPack,
    rootDir: string,
  ): Promise<{ dispatched: string[]; taskDone: boolean }> {
    const dispatched: string[] = [];
    let taskDone = false;

    let advanced = true;
    while (advanced) {
      advanced = false;

      const pendingRows = db.all(
        "SELECT title FROM subtasks WHERE task_id = ? AND title LIKE '[pipeline:%' AND status = 'pending' ORDER BY created_at ASC",
        taskId,
      ) as Array<{ title: string }>;

      for (const row of pendingRows) {
        const match = row.title.match(/^\[pipeline:([^\]]+)\]/);
        if (!match) continue;
        const rawPhaseId = match[1];
        const phaseId = rawPhaseId.includes(":") ? rawPhaseId.split(":")[0] : rawPhaseId;
        const phase = pack.graph.phases.find((p) => p.id === phaseId);
        if (!phase?.node_type) continue;
        if (!this.allUpstreamsComplete(db, taskId, phaseId, pack)) continue;

        const nodeResult = await this.executeNodeTypePhase(db, taskId, phaseId, phase, pack, rootDir);
        if (nodeResult.executed && nodeResult.status === "success") {
          dispatched.push(phaseId);
          // Advance downstream phases (still inside the lock — call private method directly).
          const phaseResult = await this._onPhaseComplete(db, taskId, phaseId, pack, rootDir);
          if (phaseResult.taskDone) taskDone = true;
          advanced = true;
          break; // Restart the outer loop after each advance to pick up newly unblocked phases.
        }
        // On error or awaiting_approval, leave the phase in its updated state and stop.
      }
    }

    return { dispatched, taskDone };
  }

  private async _onPhaseComplete(
    db: Database,
    taskId: string,
    completedPhaseId: string,
    pack: LoadedPack,
    rootDir: string,
    options?: { approved?: boolean },
  ): Promise<PhaseCompleteResult> {
    const { adjacency, terminals, phases } = pack.graph;
    const phaseMap = new Map<string, Phase>(phases.map((p) => [p.id, p]));
    const completedPhase = phaseMap.get(completedPhaseId);

    if (!completedPhase) {
      return { advanced: false, nextPhases: [], taskDone: false };
    }

    // End the phase span for the completed phase
    const ts = this.traceState.get(taskId);
    const completedPhaseSpanId = ts?.phaseSpans.get(completedPhaseId);
    if (ts && completedPhaseSpanId && this.tracer) {
      this.tracer.endSpan(completedPhaseSpanId, "ok");
      ts.phaseSpans.delete(completedPhaseId);
    }
    this.metrics?.incCounter("phase.completed", { pack: pack.key, phase: completedPhaseId, status: "done" });

    // Check gate: if completed phase has user_approval gate and hasn't been
    // explicitly approved yet, set awaiting_approval and stop.
    // When called from the approval endpoint, options.approved = true
    // which skips the gate so downstream phases can actually unblock.
    if (completedPhase.gate === "user_approval" && !options?.approved) {
      db.run(
        "UPDATE subtasks SET status = ? WHERE task_id = ? AND title LIKE ? ESCAPE '\\'",
        "awaiting_approval",
        taskId,
        `[pipeline:${escapeLikePattern(completedPhaseId)}%`,
      );
      if (this.broadcastFn) {
        const updated = db.get(
          "SELECT * FROM subtasks WHERE task_id = ? AND title = ?",
          taskId,
          `[pipeline:${completedPhaseId}]`,
        );
        if (updated) this.broadcastFn("subtask_update", updated);
      }
      return { advanced: false, nextPhases: [], taskDone: false };
    }

    // Run post_run hook if defined
    if (completedPhase.hooks?.post_run) {
      const subtaskRow = db.get(
        "SELECT id FROM subtasks WHERE task_id = ? AND title = ?",
        taskId,
        `[pipeline:${completedPhaseId}]`,
      ) as { id: string } | undefined;
      const hookResult = await this.runHook(completedPhase.hooks.post_run, pack, {
        taskId,
        subtaskId: subtaskRow?.id ?? "",
        phaseId: completedPhaseId,
        rootDir,
        db,
      });
      if (!hookResult.ok) {
        logger.warn(
          { taskId, phaseId: completedPhaseId, hookError: hookResult.message },
          "Phase hook failed — phase will not advance",
        );
        return { advanced: false, nextPhases: [], taskDone: false };
      }
    }

    // Check on_review_fail
    if (completedPhase.on_review_fail) {
      const shouldRerun = await this.checkReviewFail(db, taskId, completedPhase, phaseMap, rootDir);
      if (shouldRerun) {
        return { advanced: false, nextPhases: [], taskDone: false };
      }
    }

    // Get downstream phases
    const downstream = adjacency.get(completedPhaseId) ?? [];
    const nextPhases: string[] = [];
    const taskInput = this.extractTaskInput(db, taskId, pack);

    // Wrap downstream phase advancement in a transaction for atomicity.
    // The per-task phaseLock already serialises calls, but a transaction
    // ensures partial DB writes (e.g. skip + downstream unblock) are
    // committed together or rolled back on error.
    // Only the outermost call opens a transaction — recursive calls from
    // skip_when or connector auto-dispatch reuse the existing one.
    const canTransaction = typeof db.exec === "function";
    const isOutermost = canTransaction && !this._inTransaction.has(taskId);
    if (isOutermost) {
      db.exec!("BEGIN");
      this._inTransaction.add(taskId);
    }
    try {
      for (const dsId of downstream) {
        const dsPhase = phaseMap.get(dsId);
        if (!dsPhase) continue;

        // Check if ALL upstream phases are complete or skipped
        const allUpstreamReady = this.allUpstreamsComplete(db, taskId, dsId, pack);
        if (!allUpstreamReady) continue;

        // Check skip_when
        if (dsPhase.skip_when) {
          const shouldSkip = GraphRunner.evaluateSkipWhen(dsPhase.skip_when, taskInput);
          if (shouldSkip) {
            db.run(
              "UPDATE subtasks SET status = ? WHERE task_id = ? AND title = ?",
              "skipped",
              taskId,
              `[pipeline:${dsId}]`,
            );
            // Recursively process downstream of skipped phase (already inside lock — call private method)
            const recursiveResult = await this._onPhaseComplete(db, taskId, dsId, pack, rootDir);
            nextPhases.push(...recursiveResult.nextPhases);
            continue;
          }
        }

        // Run pre_run hook if defined on the downstream phase
        if (dsPhase.hooks?.pre_run) {
          const dsSubtaskRow = db.get(
            "SELECT id FROM subtasks WHERE task_id = ? AND title = ?",
            taskId,
            `[pipeline:${dsId}]`,
          ) as { id: string } | undefined;
          const preHookResult = await this.runHook(dsPhase.hooks.pre_run, pack, {
            taskId,
            subtaskId: dsSubtaskRow?.id ?? "",
            phaseId: dsId,
            rootDir,
            db,
          });
          if (!preHookResult.ok) {
            // Pre-run hook failed — keep phase blocked
            continue;
          }
        }

        // Handle fan-out phases
        if (dsPhase.fan_out) {
          const count = await this.resolveFanOutCount(rootDir, dsPhase, pack);
          this.createFanOutSubtasks(db, taskId, dsId, count);
          nextPhases.push(dsId);
          continue;
        }

        // Run artifact bridging
        const outputDefs = this.buildOutputDefsMap(pack);
        await bridgeArtifactsForPhase(db, { taskId, rootDir, packDir: rootDir }, dsId, dsPhase.inputs, outputDefs);

        // Auto-dispatch: if phase has node_type, execute via NodeTypeRegistry.
        if (dsPhase.node_type && this.nodeTypeRegistry) {
          const nodeResult = await this.executeNodeTypePhase(db, taskId, dsId, dsPhase, pack, rootDir);
          if (nodeResult.executed) {
            if (nodeResult.status === "success") {
              const recursiveResult = await this._onPhaseComplete(db, taskId, dsId, pack, rootDir);
              nextPhases.push(...recursiveResult.nextPhases);
            }
            // awaiting_approval: stop here, user must approve
            // error: already reset to pending for manual retry
            continue;
          }
          // nodeResult.executed === false means node type not found — log and fall through to agent
          logger.error(
            { module: "graph-runner", taskId, phaseId: dsId, error: nodeResult.error },
            "node_type_fallback",
          );
        }

        // Auto-dispatch: if phase has capability_mode "server" and a connector is bound,
        // execute the connector directly without spawning an agent.
        if (dsPhase.capability_mode === "server" && dsPhase.capability && this.connectorRegistry) {
          // Start connector span
          let connSpanId: string | undefined;
          if (this.tracer && ts) {
            connSpanId = this.tracer.startSpan(
              ts.traceId,
              `connector:${dsPhase.capability}`,
              "connector",
              ts.rootSpanId,
              { phaseId: dsId, capability: dsPhase.capability },
            );
          }
          const autoResult = await this.executeConnectorPhase(db, taskId, dsId, dsPhase, pack, rootDir);
          if (connSpanId && this.tracer) {
            this.tracer.endSpan(connSpanId, autoResult.executed ? "ok" : "error");
          }
          this.metrics?.incCounter("connector.call", {
            capability: dsPhase.capability,
            status: autoResult.executed ? "ok" : "error",
          });
          if (autoResult.executed) {
            // Connector succeeded — mark phase done and recurse (already inside lock — call private method)
            const recursiveResult = await this._onPhaseComplete(db, taskId, dsId, pack, rootDir);
            nextPhases.push(...recursiveResult.nextPhases);
            continue;
          }
          // Connector failed or not bound — fall through to agent (pending)
        }

        // Unblock existing subtask — guard with AND status = 'blocked' to avoid double-advancing
        db.run(
          "UPDATE subtasks SET status = ? WHERE task_id = ? AND title = ? AND status = ?",
          "pending",
          taskId,
          `[pipeline:${dsId}]`,
          "blocked",
        );
        // Start a phase span for the newly unblocked phase
        if (this.tracer && ts) {
          const phaseSpanId = this.tracer.startSpan(ts.traceId, `phase:${dsId}`, "phase", ts.rootSpanId, {
            phaseId: dsId,
            taskId,
          });
          ts.phaseSpans.set(dsId, phaseSpanId);
        }
        nextPhases.push(dsId);
      }

      if (isOutermost) db.exec!("COMMIT");
    } catch (txErr) {
      if (isOutermost) {
        try {
          db.exec!("ROLLBACK");
        } catch (rollbackErr) {
          logger.warn(
            { err: rollbackErr, originalErr: txErr, taskId, operation: "transaction_rollback" },
            "rollback best-effort failed — original error also attached",
          );
        }
      }
      throw txErr;
    } finally {
      if (isOutermost) this._inTransaction.delete(taskId);
    }

    // Check if all terminal phases are complete
    const taskDone = this.allTerminalsComplete(db, taskId, terminals);

    // End workflow span if task is done
    if (taskDone && ts && this.tracer) {
      this.tracer.endSpan(ts.rootSpanId, "ok");
      this.traceState.delete(taskId);
      this.metrics?.incCounter("workflow.completed", { pack: pack.key, status: "ok" });
    }

    return {
      advanced: nextPhases.length > 0,
      nextPhases,
      taskDone,
    };
  }

  // =========================================================================
  // cleanupTask — call on failure, cancellation, or completion
  // =========================================================================

  /** Remove trace state for a task — call on failure, cancellation, or completion. */
  cleanupTask(taskId: string): void {
    const entry = this.traceState.get(taskId);
    if (entry && this.tracer) {
      for (const spanId of entry.phaseSpans.values()) {
        this.tracer.endSpan(spanId, "cancelled");
      }
      this.tracer.endSpan(entry.rootSpanId, "cancelled");
    }
    this.traceState.delete(taskId);
  }

  // =========================================================================
  // buildPhaseContext — position-in-workflow summary for agent prompts
  // =========================================================================

  buildPhaseContext(pack: LoadedPack, phaseId: string): string {
    const phaseIds = pack.graph.phases.map((p) => p.id);
    const currentIndex = phaseIds.indexOf(phaseId);
    if (currentIndex === -1) return "";

    const total = phaseIds.length;
    const position = currentIndex + 1;
    const phaseList = phaseIds.map((id, i) => `${i === currentIndex ? "→" : " "} ${i + 1}. ${id}`).join("\n");

    return `[Workflow Progress] Phase ${position}/${total}\n${phaseList}`;
  }

  // =========================================================================
  // buildPhasePrompt
  // =========================================================================

  buildPhasePrompt(pack: LoadedPack, phaseId: string, lang: string): string {
    const parts: string[] = [];

    // Shared pack-level guidance (common to all phases)
    const shared = pack.sharedGuidanceCache.get(lang) ?? pack.sharedGuidanceCache.get("en") ?? "";
    if (shared) {
      parts.push(shared);
    }

    // Phase-specific guidance
    const guidance = pack.guidanceCache.get(`${phaseId}.${lang}`) ?? pack.guidanceCache.get(`${phaseId}.en`) ?? "";
    if (guidance) {
      parts.push(guidance);
    }

    // Append connector guidance if phase has a capability
    const phase = pack.graph.phases.find((p) => p.id === phaseId);
    if (phase?.capability && this.connectorRegistry) {
      const connectorGuidance = this.connectorRegistry.getAgentGuidance(phase.capability, lang);
      if (connectorGuidance) {
        parts.push("\n--- Connector Guidance ---\n" + connectorGuidance);
      }
    }

    return parts.join("\n\n");
  }

  // =========================================================================
  // evaluateSkipWhen — static so tests can call it directly
  // =========================================================================

  static evaluateSkipWhen(expression: string, taskInput: Record<string, unknown>): boolean {
    // Try " == " split
    const eqIdx = expression.indexOf(" == ");
    if (eqIdx !== -1) {
      const left = expression.substring(0, eqIdx).trim();
      const right = expression.substring(eqIdx + 4).trim();
      const resolvedLeft = GraphRunner.resolveDotPath(left, taskInput);
      const resolvedRight = stripQuotes(right);
      return String(resolvedLeft) === resolvedRight;
    }

    // Try " != " split
    const neqIdx = expression.indexOf(" != ");
    if (neqIdx !== -1) {
      const left = expression.substring(0, neqIdx).trim();
      const right = expression.substring(neqIdx + 4).trim();
      const resolvedLeft = GraphRunner.resolveDotPath(left, taskInput);
      const resolvedRight = stripQuotes(right);
      return String(resolvedLeft) !== resolvedRight;
    }

    return false;
  }

  // =========================================================================
  // Private helpers
  // =========================================================================

  private resolvePackInputs(phase: Phase, taskInput: Record<string, unknown>): string[] {
    const parts: string[] = [];
    for (const input of phase.inputs) {
      const parsed = parseInputRef(input.from);
      if (parsed.isPackInput) {
        const value = GraphRunner.resolveDotPath(input.from, taskInput);
        if (value !== undefined) {
          parts.push(`${input.name}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`);
        }
      }
    }
    return parts;
  }

  private static resolveDotPath(path: string, input: Record<string, unknown>): unknown {
    // Strip "input." prefix if present
    const normalized = path.startsWith("input.") ? path.slice(6) : path;
    const segments = normalized.split(".");

    let current: unknown = input;
    for (const segment of segments) {
      if (current === null || current === undefined || typeof current !== "object") {
        return undefined;
      }
      current = (current as Record<string, unknown>)[segment];
    }
    return current;
  }

  private allUpstreamsComplete(db: Database, taskId: string, phaseId: string, pack: LoadedPack): boolean {
    const upstreams = pack.graph.reverseAdjacency.get(phaseId) ?? [];

    for (const upId of upstreams) {
      const upPhase = pack.graph.phases.find((p) => p.id === upId);

      // For fan-out phases, check all fan-out subtasks
      if (upPhase?.fan_out) {
        const fanOutSubtasks = db.all(
          "SELECT * FROM subtasks WHERE task_id = ? AND title LIKE ? ESCAPE '\\'",
          taskId,
          `[pipeline:${escapeLikePattern(upId)}%`,
        ) as SubtaskRow[];

        const allDone =
          fanOutSubtasks.length > 0 && fanOutSubtasks.every((s) => s.status === "done" || s.status === "skipped");
        if (!allDone) return false;
      } else {
        const subtask = db.get(
          "SELECT * FROM subtasks WHERE task_id = ? AND title = ?",
          taskId,
          `[pipeline:${upId}]`,
        ) as SubtaskRow | undefined;

        if (!subtask || (subtask.status !== "done" && subtask.status !== "skipped")) {
          return false;
        }
      }
    }

    return true;
  }

  private allTerminalsComplete(db: Database, taskId: string, terminals: string[]): boolean {
    for (const termId of terminals) {
      // Check main subtask and any fan-out subtasks
      const subtasks = db.all(
        "SELECT * FROM subtasks WHERE task_id = ? AND title LIKE ? ESCAPE '\\'",
        taskId,
        `[pipeline:${escapeLikePattern(termId)}%`,
      ) as SubtaskRow[];

      const allDone = subtasks.length > 0 && subtasks.every((s) => s.status === "done" || s.status === "skipped");
      if (!allDone) return false;
    }
    return true;
  }

  private async checkReviewFail(
    db: Database,
    taskId: string,
    completedPhase: Phase,
    _phaseMap: Map<string, Phase>,
    rootDir?: string,
  ): Promise<boolean> {
    const reviewConfig = completedPhase.on_review_fail!;
    const targetPhaseId = reviewConfig.rerun;

    // Validate that the rerun target phase still exists in the pack
    if (!_phaseMap.has(targetPhaseId)) {
      logger.warn(
        { taskId, reviewPhase: completedPhase.id, targetPhaseId, operation: "review_fail_rerun" },
        "review-fail rerun target phase not found in pack — skipping rerun",
      );
      return false;
    }

    // Read the flag_output artifact file to determine if failures exist
    const flagOutputDef = completedPhase.outputs.find((o) => o.name === reviewConfig.flag_output);
    if (!flagOutputDef) return false;

    const flagPath = flagOutputDef.path.startsWith("/")
      ? flagOutputDef.path
      : join(rootDir ?? process.cwd(), flagOutputDef.path);

    try {
      const raw = await readFile(flagPath, "utf8");
      const flags = JSON.parse(raw);
      // If it's an array, failures exist when array is non-empty
      // If it's an object with a "failures" or "items" key, check that
      const hasFailures = Array.isArray(flags)
        ? flags.length > 0
        : flags.failures?.length > 0 || flags.items?.length > 0 || flags.regen_needed === true;
      if (!hasFailures) return false;
    } catch (err) {
      logger.debug(
        { err, taskId, operation: "parse_qa_flags" },
        "cannot read/parse QA flag output — treating as no failures",
      );
      return false;
    }

    // Enforce max_passes by tracking regen count in workflow_meta_json
    const task = db.get("SELECT workflow_meta_json FROM tasks WHERE id = ?", taskId) as
      | { workflow_meta_json?: string }
      | undefined;
    const meta = task?.workflow_meta_json ? JSON.parse(task.workflow_meta_json) : {};
    const regenKey = `regen_count_${completedPhase.id}`;
    const currentCount: number = meta[regenKey] ?? 0;
    if (currentCount >= reviewConfig.max_passes) {
      // Max retries reached — proceed without re-running
      return false;
    }
    meta[regenKey] = currentCount + 1;
    db.run("UPDATE tasks SET workflow_meta_json = ? WHERE id = ?", JSON.stringify(meta), taskId);

    const targetSubtask = db.get(
      "SELECT * FROM subtasks WHERE task_id = ? AND title = ?",
      taskId,
      `[pipeline:${targetPhaseId}]`,
    ) as SubtaskRow | undefined;

    if (!targetSubtask) return false;

    // Re-activate target phase
    db.run(
      "UPDATE subtasks SET status = ? WHERE task_id = ? AND title = ?",
      "pending",
      taskId,
      `[pipeline:${targetPhaseId}]`,
    );

    // Also reset the review phase itself to blocked so it re-runs after the target completes.
    // Without this, the review phase stays done and the retry loop breaks on the next pass.
    db.run(
      "UPDATE subtasks SET status = ? WHERE task_id = ? AND title = ?",
      "blocked",
      taskId,
      `[pipeline:${completedPhase.id}]`,
    );

    return true;
  }

  private async resolveFanOutCount(rootDir: string, phase: Phase, pack: LoadedPack): Promise<number> {
    if (!phase.fan_out) return 1;

    const countFrom = phase.fan_out.count_from;

    // Pack input reference (e.g. "input.crawler_count") — resolved during seeding, not from file
    if (countFrom.startsWith("input.")) {
      return 1;
    }

    // Parse the reference: e.g. "screenplay.shot_list.scenes.length"
    const parsed = parseInputRef(countFrom);
    const outputDefs = this.buildOutputDefsMap(pack);
    const defKey = `${parsed.sourcePhaseId}.${parsed.outputName}`;
    const outputDef = outputDefs.get(defKey);

    if (!outputDef) return 1;

    const filePath = outputDef.path.startsWith("/") ? outputDef.path : join(rootDir, outputDef.path);

    try {
      const raw = await readFile(filePath, "utf8");
      const json = JSON.parse(raw);

      if (parsed.jsonPath) {
        // Navigate the JSON path: ".scenes.length" → json.scenes.length
        const pathParts = parsed.jsonPath.replace(/^\./, "").split(".");
        let current: unknown = json;
        for (const part of pathParts) {
          if (current == null || typeof current !== "object") return 1;
          if (part === "length" && Array.isArray(current)) {
            return current.length > 0 ? current.length : 1;
          }
          current = (current as Record<string, unknown>)[part];
        }
        const num = typeof current === "number" ? current : parseInt(String(current), 10);
        return !isNaN(num) && num > 0 ? num : 1;
      }

      return 1;
    } catch (err) {
      logger.debug(
        { err, phaseId: phase.id, operation: "resolve_fan_out_count" },
        "cannot resolve fan-out count — defaulting to 1",
      );
      return 1;
    }
  }

  private createFanOutSubtasks(db: Database, taskId: string, phaseId: string, count: number): void {
    const now = Date.now();

    // Remove the placeholder subtask
    // (we update its title to be the first fan-out instance)
    if (count === 1) {
      // Just unblock the existing placeholder
      db.run(
        "UPDATE subtasks SET status = ? WHERE task_id = ? AND title = ?",
        "pending",
        taskId,
        `[pipeline:${phaseId}]`,
      );
      return;
    }

    // Update placeholder to first instance
    db.run(
      "UPDATE subtasks SET status = ? WHERE task_id = ? AND title = ?",
      "pending",
      taskId,
      `[pipeline:${phaseId}]`,
    );

    // Create additional fan-out subtasks
    for (let i = 1; i < count; i++) {
      const id = randomUUID();
      db.run(
        "INSERT INTO subtasks (id, task_id, title, description, status, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        id,
        taskId,
        `[pipeline:${phaseId}:${i}]`,
        `Fan-out instance ${i} of phase: ${phaseId}`,
        "pending",
        now,
      );
    }
  }

  private buildOutputDefsMap(pack: LoadedPack): Map<string, PhaseOutput> {
    const map = new Map<string, PhaseOutput>();
    for (const phase of pack.graph.phases) {
      for (const output of phase.outputs) {
        map.set(`${phase.id}.${output.name}`, output);
      }
    }
    return map;
  }

  private extractTaskInput(db: Database, taskId: string, _pack: LoadedPack): Record<string, unknown> {
    // Read from the metadata subtask created during seeding
    const metaSubtask = db.get(
      "SELECT * FROM subtasks WHERE task_id = ? AND title = ?",
      taskId,
      "[pipeline:__input__]",
    ) as SubtaskRow | undefined;

    if (!metaSubtask?.description) return {};

    try {
      return JSON.parse(metaSubtask.description) as Record<string, unknown>;
    } catch (err) {
      logger.debug(
        { err, taskId, operation: "parse_subtask_input" },
        "malformed subtask description JSON — using empty input",
      );
      return {};
    }
  }

  /**
   * Execute a connector phase directly without spawning an agent.
   * Reads input artifacts, calls the connector, and saves outputs.
   */
  private async executeConnectorPhase(
    db: Database,
    taskId: string,
    phaseId: string,
    phase: Phase,
    _pack: LoadedPack,
    rootDir: string,
  ): Promise<{ executed: boolean; error?: string }> {
    if (!phase.capability || !this.connectorRegistry) {
      return { executed: false, error: "no capability or registry" };
    }

    try {
      // Build connector input from phase input artifacts
      const connectorInput: Record<string, unknown> = {};

      const outputDefs = this.buildOutputDefsMap(_pack);
      for (const input of phase.inputs) {
        const { content, warning } = await resolveArtifactRef(rootDir, input.from, outputDefs);
        if (warning) {
          logger.debug({ taskId, phaseId, ref: input.from, operation: "read_connector_input" }, warning);
        }
        if (content !== null) {
          // Try to parse as JSON if the input looks like JSON
          try {
            connectorInput[input.name] = JSON.parse(content);
          } catch {
            connectorInput[input.name] = content;
          }
        }
      }

      // Mark subtask as in_progress
      db.run(
        "UPDATE subtasks SET status = ? WHERE task_id = ? AND title = ?",
        "in_progress",
        taskId,
        `[pipeline:${phaseId}]`,
      );

      // Execute the connector
      const result = await this.connectorRegistry.executeCapability(phase.capability, connectorInput);

      if (result.status === "success") {
        // Mark subtask as done
        db.run(
          "UPDATE subtasks SET status = ?, completed_at = ? WHERE task_id = ? AND title = ?",
          "done",
          Date.now(),
          taskId,
          `[pipeline:${phaseId}]`,
        );
        return { executed: true };
      }

      // Connector failed — log and reset subtask to pending for agent fallback
      logger.warn(
        { taskId, phaseId, capability: phase.capability, status: result.status, error: result.error },
        "connector execution failed — falling back to agent",
      );
      db.run(
        "UPDATE subtasks SET status = ? WHERE task_id = ? AND title = ?",
        "pending",
        taskId,
        `[pipeline:${phaseId}]`,
      );
      return { executed: false, error: result.error ?? "connector execution failed" };
    } catch (err) {
      // Reset subtask on exception
      db.run(
        "UPDATE subtasks SET status = ? WHERE task_id = ? AND title = ?",
        "pending",
        taskId,
        `[pipeline:${phaseId}]`,
      );
      logger.warn({ err, taskId, phaseId, operation: "execute_connector_phase" }, "connector phase execution failed");
      return { executed: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Execute a phase that has a `node_type` set.
   * Marks the subtask in_progress, calls node.execute(), marks it done or
   * awaiting_approval, and returns whether execution was handled.
   */
  private async executeNodeTypePhase(
    db: Database,
    taskId: string,
    phaseId: string,
    phase: Phase,
    pack: LoadedPack,
    rootDir: string,
  ): Promise<{ executed: boolean; status?: "success" | "error" | "awaiting_approval"; error?: string }> {
    if (!phase.node_type || !this.nodeTypeRegistry) {
      return { executed: false };
    }

    const nodeDef = this.nodeTypeRegistry.get(phase.node_type);
    if (!nodeDef) {
      return {
        executed: false,
        error:
          `Node type "${phase.node_type}" is not registered. ` +
          `Available types: ${this.nodeTypeRegistry
            .list()
            .map((n) => n.key)
            .join(", ")}`,
      };
    }

    // Mark subtask as in_progress
    db.run(
      "UPDATE subtasks SET status = ? WHERE task_id = ? AND title = ?",
      "in_progress",
      taskId,
      `[pipeline:${phaseId}]`,
    );

    try {
      // Resolve config: merge node_config from pack.yaml over defaults from configSchema
      const config: Record<string, unknown> = {};
      for (const field of nodeDef.configSchema) {
        config[field.key] = field.default;
      }
      if (phase.node_config) {
        Object.assign(config, phase.node_config);
      }

      // Resolve inputs via resolveArtifactRef so all legal from: forms are supported:
      // direct, wildcard, indexed, JSON-path, and pack inputs.
      const outputDefs = this.buildOutputDefsMap(pack);
      const taskInput = this.extractTaskInput(db, taskId, pack);
      const inputs: Record<string, unknown> = {};
      for (const input of phase.inputs) {
        const parsed = parseInputRef(input.from);

        // Pack inputs (input.foo, input.meta.depth, …) are not file-based.
        // Use resolveDotPath so nested paths are supported consistently with the
        // rest of the graph-runner (e.g. skip_when / evaluateSkipWhen).
        if (parsed.isPackInput) {
          const value = GraphRunner.resolveDotPath(input.from, taskInput);
          if (value !== undefined) {
            inputs[input.name] = value;
          }
          continue;
        }

        const { content, warning } = await resolveArtifactRef(rootDir, input.from, outputDefs);
        if (warning) {
          logger.warn(`[graph-runner] node input resolution: ${warning}`);
        }
        if (content !== null) {
          // Parse JSON outputs so nodes receive structured data, not raw strings.
          const cleanKey = `${parsed.sourcePhaseId}.${parsed.outputName.replace(/\[\{n\}\]$/, "").replace(/\[\d+\]$/, "")}`;
          const outputDef = outputDefs.get(cleanKey);
          if (outputDef?.type === "json") {
            try {
              inputs[input.name] = JSON.parse(content);
            } catch (err) {
              logger.debug(
                { err, taskId, phaseId, operation: "parse_node_input_json" },
                "cannot parse node input as JSON — using raw content",
              );
              inputs[input.name] = content;
            }
          } else {
            inputs[input.name] = content;
          }
        }
      }

      const ctx: NodeExecuteContext = {
        taskId,
        phaseId,
        inputs,
        config,
        db,
        connectorRegistry: this.connectorRegistry,
        lang: "en", // Node type context always uses "en"; guidance lookup has its own lang fallback
      };

      const NODE_TYPE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        nodeDef.execute(ctx),
        new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(
            () => reject(new Error(`node type "${phase.node_type}" timed out after ${NODE_TYPE_TIMEOUT_MS}ms`)),
            NODE_TYPE_TIMEOUT_MS,
          );
        }),
      ]).finally(() => clearTimeout(timeoutHandle));

      // Persist declared outputs for both success and awaiting_approval.
      // For awaiting_approval the UI needs the data (plan, handoffs, etc.)
      // so the user can review before approving.
      if (result.status === "success" || result.status === "awaiting_approval") {
        for (const outputDef of phase.outputs) {
          const value = result.outputs[outputDef.name];
          if (value !== undefined) {
            const absPath = outputDef.path.startsWith("/") ? outputDef.path : join(rootDir, outputDef.path);
            await mkdir(dirname(absPath), { recursive: true });
            const content = typeof value === "string" ? value : JSON.stringify(value, null, 2);
            await writeFile(absPath, content, "utf-8");
          }
        }
        if (result.summary) {
          logger.info(`[graph-runner] [${taskId}] [${phaseId}] ${result.summary}`);
        }
      }

      if (result.status === "success") {
        db.run(
          "UPDATE subtasks SET status = ?, completed_at = ? WHERE task_id = ? AND title = ?",
          "done",
          Date.now(),
          taskId,
          `[pipeline:${phaseId}]`,
        );
        return { executed: true, status: "success" };
      }

      if (result.status === "awaiting_approval") {
        db.run(
          "UPDATE subtasks SET status = ? WHERE task_id = ? AND title = ?",
          "awaiting_approval",
          taskId,
          `[pipeline:${phaseId}]`,
        );
        if (this.broadcastFn) {
          const updated = db.get(
            "SELECT * FROM subtasks WHERE task_id = ? AND title = ?",
            taskId,
            `[pipeline:${phaseId}]`,
          );
          if (updated) this.broadcastFn("subtask_update", updated);
        }

        // Notify configured messenger channels (Telegram etc.) so the user
        // can approve remotely by replying.
        try {
          const task = db.get("SELECT title FROM tasks WHERE id = ?", taskId) as { title: string } | undefined;
          notifyPhaseApprovalNeeded(taskId, task?.title ?? taskId, phaseId, result.summary);
        } catch (err) {
          logger.warn({ err, taskId, phaseId, operation: "notify_phase_approval" }, "best-effort notification failed");
        }

        return { executed: true, status: "awaiting_approval" };
      }

      // status === "error"
      db.run(
        "UPDATE subtasks SET status = ? WHERE task_id = ? AND title = ?",
        "pending",
        taskId,
        `[pipeline:${phaseId}]`,
      );
      return { executed: false, status: "error", error: result.error ?? "node type execution failed" };
    } catch (err) {
      db.run(
        "UPDATE subtasks SET status = ? WHERE task_id = ? AND title = ?",
        "pending",
        taskId,
        `[pipeline:${phaseId}]`,
      );
      logger.warn({ err, taskId, phaseId, operation: "execute_node_type" }, "node type execution failed");
      return { executed: false, status: "error", error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async runHook(
    hookPath: string,
    pack: LoadedPack,
    context: { taskId: string; subtaskId: string; phaseId: string; rootDir: string; db: Database },
  ): Promise<{ ok: boolean; message?: string }> {
    if (!isHookPathSafe(hookPath)) {
      return { ok: false, message: `Hook path rejected: path traversal detected in "${hookPath}"` };
    }
    try {
      const packBaseDir =
        pack.source === "built-in"
          ? join(__dirname, "../../../packs/built-in", pack.key)
          : join(__dirname, "../../../packs/community", pack.key);
      const fullPath = pathResolve(join(packBaseDir, hookPath));

      // Verify resolved path is within pack directory (defense in depth)
      const resolvedBase = pathResolve(packBaseDir);
      if (fullPath !== resolvedBase && !fullPath.startsWith(resolvedBase + sep)) {
        return { ok: false, message: `Hook path rejected: resolved path escapes pack directory` };
      }

      // Resolve symlinks to prevent TOCTOU bypass via symlink indirection.
      // Only check when the file actually exists — non-existent hooks fall
      // through to import() which produces the normal "not found" error.
      let importTarget = fullPath;
      try {
        const realFullPath = realpathSync(fullPath);
        const realBase = realpathSync(resolvedBase);
        if (realFullPath !== realBase && !realFullPath.startsWith(realBase + sep)) {
          return { ok: false, message: `Hook path rejected: symlink escapes pack directory` };
        }
        importTarget = realFullPath;
      } catch {
        // File does not exist — let import() handle the error below
      }

      const hookModule = await import(importTarget);
      const hookFn = hookModule.default ?? hookModule;
      return await hookFn({ ...context, packKey: pack.key });
    } catch (err) {
      return { ok: false, message: `Hook execution failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripQuotes(s: string): string {
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) {
    return s.slice(1, -1);
  }
  return s;
}
