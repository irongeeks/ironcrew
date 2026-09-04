/**
 * IronCrew — installing a trade into a company.
 *
 * THE THREE RULES THAT SHAPE EVERY DECISION HERE
 *
 * 1. **Reuse, never overwrite.** Every object is matched by key first. A
 *    department the operator already has is used as it stands; an agent whose
 *    key is taken is left alone. A pack adds what is missing — it does not
 *    get to redefine what a company already decided, and an install that
 *    silently rewrote an existing post would be an install nobody could trust
 *    twice.
 *
 * 2. **Register, never grant.** A pack's tools land in `crew_tools` so they
 *    *can* be granted; `ToolStore.resolve()` still fails closed until an
 *    owner grants them (docs/TOOLS.md). A pack that granted its own tools
 *    would be a pack deciding what agents may do, and that decision is the
 *    owner's — the same reason `may_approve` is a literal `false`.
 *
 * 3. **Suggest, never start.** Routines install *disabled*. A pack that began
 *    firing routines the moment it was installed would spend the owner's
 *    money on work they have not read yet. Enabling one is a decision, and it
 *    is one click (`POST /api/crew/routines/:id/enabled`).
 *
 * WHY UNINSTALL IS NOT THE MIRROR IMAGE OF INSTALL
 *
 * Because objects acquire history. A routine is safe to delete — it holds a
 * schedule and a pointer to its last task. A tool is not: deleting it would
 * orphan every grant an owner made, so it is disabled instead, exactly as
 * `syncMcpTools` disables an MCP server that vanished from the config. An
 * agent is deleted only if it never worked — no task assigned, no run, no
 * grant of its own; otherwise it stays, because `ON DELETE SET NULL` would
 * quietly turn "Keel did this" into "somebody did this" across the whole
 * board. A department goes only when it is empty.
 *
 * So uninstall reports what it kept and why, and the operator decides whether
 * to clean up by hand. A remover that silently leaves things behind is worse
 * than one that refuses; a remover that silently destroys history is worse
 * than both.
 */

import type { DatabaseSync } from "node:sqlite";
import { newId } from "../domain/ids.ts";
import { oneRow } from "../domain/sql.ts";
import { appendAuditEvent, type ActorType } from "../domain/audit.ts";
import { ToolStore } from "../domain/tool-store.ts";
import { RoutineStore } from "../domain/routine-store.ts";
import { PackMutationError, PackStore, type PackObjectType, type PackRow } from "./pack-store.ts";
import type { BusinessPack } from "./business-pack.ts";
import type { CompanyOrchestrator } from "../orchestrator/company.ts";
import { logger } from "../../observability/logger.ts";

const log = logger.child({ module: "ironcrew-packs" });

export interface InstallOpts {
  actorType?: ActorType;
  actorId?: string;
}

export interface InstalledCounts {
  departments: number;
  agents: number;
  tools: number;
  routines: number;
}

export interface InstallResult {
  pack: PackRow;
  /** What this install actually created, as opposed to found already there. */
  created: InstalledCounts;
  /** Objects that existed under the same key and were reused untouched. */
  reused: InstalledCounts;
}

export interface KeptObject {
  type: PackObjectType;
  id: string;
  key: string;
  reason: string;
}

export interface UninstallResult {
  packKey: string;
  removed: InstalledCounts;
  /** Tools are disabled rather than deleted; see this module's header. */
  disabledTools: number;
  kept: KeptObject[];
}

export class PackInstaller {
  private readonly packs: PackStore;
  private readonly tools: ToolStore;
  private readonly routines: RoutineStore;

  constructor(
    private readonly db: DatabaseSync,
    private readonly orchestrator: CompanyOrchestrator,
  ) {
    this.packs = new PackStore(db);
    this.tools = new ToolStore(db);
    this.routines = new RoutineStore(db);
  }

  get store(): PackStore {
    return this.packs;
  }

  isInstalled(companyId: string, packKey: string): boolean {
    return this.packs.byKey(companyId, packKey) !== null;
  }

  /**
   * Installs a pack, or refuses if it is already there.
   *
   * Not idempotent-by-silence on purpose: "install what is already installed"
   * is a mistake worth reporting, and the caller that meant "make sure it is
   * there" can ask `isInstalled` first. A silent no-op would hide a typo in a
   * pack key behind a cheerful success.
   */
  install(companyId: string, pack: BusinessPack, opts: InstallOpts = {}): InstallResult {
    const row = this.packs.install({
      companyId,
      packKey: pack.key,
      version: pack.version,
      installedBy: opts.actorId ?? "ceo",
    });

    const created: InstalledCounts = { departments: 0, agents: 0, tools: 0, routines: 0 };
    const reused: InstalledCounts = { departments: 0, agents: 0, tools: 0, routines: 0 };

    // Departments first: the agents below need their ids.
    const departmentIds = new Map<string, string>();
    for (const department of pack.departments) {
      const existing = this.findDepartment(companyId, department.key);
      if (existing) {
        departmentIds.set(department.key, existing);
        reused.departments += 1;
        continue;
      }
      const id = newId("dept");
      this.db
        .prepare(
          "INSERT INTO crew_departments (id, company_id, key, name, description, sort_order) VALUES (?,?,?,?,?,?)",
        )
        .run(id, companyId, department.key, department.name, department.description, department.sort_order);
      departmentIds.set(department.key, id);
      this.packs.record({
        packId: row.id,
        companyId,
        objectType: "department",
        objectId: id,
        objectKey: department.key,
      });
      created.departments += 1;
    }

    for (const agent of pack.agents) {
      if (this.orchestrator.getAgent(companyId, agent.key)) {
        reused.agents += 1;
        continue;
      }
      // A department the pack brings, or one the company was seeded with.
      const departmentId = departmentIds.get(agent.department) ?? this.findDepartment(companyId, agent.department);
      const id = this.orchestrator.hireAgent(companyId, agent, departmentId);
      this.packs.record({ packId: row.id, companyId, objectType: "agent", objectId: id, objectKey: agent.key });
      created.agents += 1;
    }

    for (const tool of pack.tools) {
      const existing = this.tools.byKey(companyId, tool.key);
      if (existing) {
        reused.tools += 1;
        continue;
      }
      const registered = this.tools.register(
        {
          companyId,
          key: tool.key,
          label: tool.label,
          description: tool.description,
          riskClass: tool.risk_class,
          origin: "pack",
        },
        { actorType: opts.actorType ?? "owner", actorId: opts.actorId ?? "ceo" },
      );
      this.packs.record({
        packId: row.id,
        companyId,
        objectType: "tool",
        objectId: registered.id,
        objectKey: tool.key,
      });
      created.tools += 1;
    }

    for (const routine of pack.routines) {
      if (this.findRoutine(companyId, routine.name)) {
        reused.routines += 1;
        continue;
      }
      const registered = this.routines.create(
        {
          companyId,
          name: routine.name,
          instruction: routine.instruction,
          intervalMinutes: routine.interval_minutes,
          // Rule 3: a pack suggests work, it does not start it.
          enabled: false,
        },
        { actorType: opts.actorType ?? "owner", actorId: opts.actorId ?? "ceo" },
      );
      this.packs.record({
        packId: row.id,
        companyId,
        objectType: "routine",
        objectId: registered.id,
        objectKey: routine.key,
      });
      created.routines += 1;
    }

    appendAuditEvent(this.db, {
      companyId,
      actorType: opts.actorType ?? "owner",
      actorId: opts.actorId ?? "ceo",
      action: "pack.installed",
      entityType: "pack",
      entityId: row.id,
      details: { packKey: pack.key, version: pack.version, created, reused },
    });
    log.info({ companyId, packKey: pack.key, created, reused }, "business pack installed");

    return { pack: row, created, reused };
  }

  /**
   * Removes a pack's own objects, keeping anything that has since been used.
   *
   * Order matters: routines and tools first, then agents, then departments —
   * a department cannot go while it still holds an agent this pass decided to
   * keep.
   */
  uninstall(companyId: string, packKey: string, opts: InstallOpts = {}): UninstallResult {
    const row = this.packs.byKey(companyId, packKey);
    if (!row) throw new PackMutationError(`Pack "${packKey}" ist nicht installiert.`);

    const removed: InstalledCounts = { departments: 0, agents: 0, tools: 0, routines: 0 };
    const kept: KeptObject[] = [];
    let disabledTools = 0;

    for (const object of this.packs.objects(row.id, "routine")) {
      this.routines.delete(object.object_id, { actorType: opts.actorType ?? "owner", actorId: opts.actorId ?? "ceo" });
      removed.routines += 1;
    }

    for (const object of this.packs.objects(row.id, "tool")) {
      // Disabled, not deleted: deleting would orphan every grant an owner
      // made, which is the same reason syncMcpTools disables a vanished MCP
      // server instead of removing it.
      this.tools.setEnabled(object.object_id, false, {
        actorType: opts.actorType ?? "owner",
        actorId: opts.actorId ?? "ceo",
      });
      disabledTools += 1;
    }

    for (const object of this.packs.objects(row.id, "agent")) {
      const blocker = this.agentInUse(object.object_id);
      if (blocker) {
        kept.push({ type: "agent", id: object.object_id, key: object.object_key, reason: blocker });
        continue;
      }
      // The role goes with the post, but only if nobody else holds it. A
      // talent outlives its agent by design (Vessel × Talent), so deleting it
      // unconditionally would take a role out from under a second holder —
      // and leaving it always would litter the org with roles nobody has.
      const talentId = oneRow<{ talent_id: string | null }>(
        this.db.prepare("SELECT talent_id FROM crew_agents WHERE id = ?"),
        object.object_id,
      )?.talent_id;

      this.db.prepare("DELETE FROM crew_agents WHERE id = ?").run(object.object_id);
      removed.agents += 1;

      if (talentId) {
        const holders = oneRow<{ n: number }>(
          this.db.prepare("SELECT COUNT(*) AS n FROM crew_agents WHERE talent_id = ?"),
          talentId,
        );
        if ((holders?.n ?? 0) === 0) {
          this.db.prepare("DELETE FROM crew_talents WHERE id = ?").run(talentId);
        }
      }
    }

    for (const object of this.packs.objects(row.id, "department")) {
      const agents = oneRow<{ n: number }>(
        this.db.prepare("SELECT COUNT(*) AS n FROM crew_agents WHERE department_id = ?"),
        object.object_id,
      );
      if ((agents?.n ?? 0) > 0) {
        kept.push({
          type: "department",
          id: object.object_id,
          key: object.object_key,
          reason:
            agents?.n === 1
              ? "In der Abteilung sitzt noch ein Posten."
              : `In der Abteilung sitzen noch ${agents?.n} Posten.`,
        });
        continue;
      }
      this.db.prepare("DELETE FROM crew_departments WHERE id = ?").run(object.object_id);
      removed.departments += 1;
    }

    this.packs.remove(companyId, packKey);

    appendAuditEvent(this.db, {
      companyId,
      actorType: opts.actorType ?? "owner",
      actorId: opts.actorId ?? "ceo",
      action: "pack.uninstalled",
      entityType: "pack",
      entityId: row.id,
      details: { packKey, removed, disabledTools, kept: kept.map((k) => `${k.type}:${k.key}`) },
    });
    log.info({ companyId, packKey, removed, disabledTools, kept: kept.length }, "business pack uninstalled");

    return { packKey, removed, disabledTools, kept };
  }

  /**
   * Why this agent may not be deleted, or null when it may.
   *
   * Tasks and runs are checked, not audit entries: the audit log stores actor
   * ids as plain text and survives the row it names, which is what makes it
   * an audit log. A task, by contrast, would have its `assigned_agent_id`
   * quietly set to NULL — turning "Keel did this" into "somebody did this"
   * across the whole board.
   */
  private agentInUse(agentId: string): string | null {
    // German, and read at the moment an operator is surprised by it — so the
    // singular reads like a sentence rather than like a counter.
    const tasks = this.countFor("crew_tasks", "assigned_agent_id", agentId);
    if (tasks > 0) {
      return tasks === 1
        ? "Es hängt noch eine Aufgabe an diesem Posten."
        : `Es hängen noch ${tasks} Aufgaben an diesem Posten.`;
    }

    const runs = this.countFor("crew_runs", "agent_id", agentId);
    if (runs > 0) {
      return runs === 1
        ? "Dieser Posten hat bereits einen Lauf hinter sich."
        : `Dieser Posten hat bereits ${runs} Läufe hinter sich.`;
    }

    const grants = this.countFor("crew_tool_grants", "agent_id", agentId);
    if (grants > 0) {
      return grants === 1
        ? "Für diesen Posten ist eine Werkzeug-Freigabe erteilt."
        : `Für diesen Posten sind ${grants} Werkzeug-Freigaben erteilt.`;
    }

    return null;
  }

  /**
   * Table and column are interpolated, and that is safe here precisely
   * because both are literals from the three call sites above — never a
   * parameter, never anything a request can reach. The id is bound.
   */
  private countFor(table: string, column: string, id: string): number {
    return oneRow<{ n: number }>(this.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`), id)?.n ?? 0;
  }

  private findDepartment(companyId: string, key: string): string | null {
    return (
      oneRow<{ id: string }>(
        this.db.prepare("SELECT id FROM crew_departments WHERE company_id = ? AND key = ?"),
        companyId,
        key,
      )?.id ?? null
    );
  }

  private findRoutine(companyId: string, name: string): string | null {
    return (
      oneRow<{ id: string }>(
        this.db.prepare("SELECT id FROM crew_routines WHERE company_id = ? AND name = ?"),
        companyId,
        name,
      )?.id ?? null
    );
  }
}
