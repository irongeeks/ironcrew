/**
 * Installing a trade into a company.
 *
 * The three rules from the installer's header are what these tests are for:
 * reuse never overwrites, registering is not granting, and a routine does not
 * start itself. Each of those is a decision somebody could "simplify" away in
 * a year, and each would be a real loss — so each has a test that says why.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createTestDb } from "../domain/test-db.ts";
import { CompanyOrchestrator } from "../orchestrator/company.ts";
import { PackInstaller } from "./pack-installer.ts";
import { PackMutationError, PackStore } from "./pack-store.ts";
import { defineBusinessPack, type BusinessPack } from "./business-pack.ts";
import { ToolStore } from "../domain/tool-store.ts";
import { RoutineStore } from "../domain/routine-store.ts";
import { BUSINESS_PACKS } from "./catalog.ts";
import { listAuditEvents } from "../domain/audit.ts";

let db: DatabaseSync;
let orchestrator: CompanyOrchestrator;
let installer: PackInstaller;
let companyId: string;

/** A pack small enough to reason about, with one of everything. */
function testPack(over: Partial<BusinessPack> = {}): BusinessPack {
  return defineBusinessPack({
    key: "test-trade",
    version: "1.0.0",
    label: "Testgewerbe",
    summary: "Ein Pack, klein genug zum Nachdenken.",
    departments: [{ key: "service-desk", name: "Service Desk", description: "Erste Anlaufstelle", sort_order: 500 }],
    agents: [
      {
        key: "desk",
        department: "service-desk",
        professional_role: "Service-Desk-Mitarbeiter",
        role_summary: "Nimmt Störungen auf und ordnet sie ein.",
        seniority: "junior",
        skin: { display_name: "Tresen" },
        policy: { max_risk_level: "low" },
      },
    ],
    tools: [{ key: "test.inventory", label: "Testinventar", description: "Liest Bestand", risk_class: "read" }],
    routines: [
      {
        key: "morning",
        name: "Morgendliche Sichtung",
        instruction: "Sieh die offenen Störungen durch und fasse zusammen, was heute dringend ist.",
        interval_minutes: 1440,
      },
    ],
    integrations: [],
    ...over,
  });
}

beforeEach(() => {
  db = createTestDb();
  orchestrator = new CompanyOrchestrator(db);
  companyId = orchestrator.seedCompany({ name: "Test", slug: "test" });
  installer = new PackInstaller(db, orchestrator);
});

afterEach(() => db.close());

describe("installing", () => {
  it("creates the department, the post, the tool and the routine", () => {
    const result = installer.install(companyId, testPack());

    expect(result.created).toEqual({ departments: 1, agents: 1, tools: 1, routines: 1 });
    expect(result.reused).toEqual({ departments: 0, agents: 0, tools: 0, routines: 0 });
    expect(orchestrator.getAgent(companyId, "desk")?.display_name).toBe("Tresen");
    expect(new ToolStore(db).byKey(companyId, "test.inventory")?.risk_class).toBe("read");
  });

  it("attaches the new post to the department the pack brought", () => {
    installer.install(companyId, testPack());
    const agent = orchestrator.getAgent(companyId, "desk")!;
    const department = db.prepare("SELECT key FROM crew_departments WHERE id = ?").get(agent.department_id) as {
      key: string;
    };
    expect(department.key).toBe("service-desk");
  });

  it("attaches a post to a seeded department when the pack reuses one", () => {
    installer.install(
      companyId,
      testPack({
        departments: [],
        agents: [
          {
            key: "controller",
            department: "finance",
            professional_role: "Controller",
            role_summary: "Behält die Zahlen im Blick.",
            seniority: "senior",
            is_executive_assistant: false,
            runtime_profile: "balanced",
            skin: {
              display_name: "Zahlwerk",
              accent: "cyan",
              traits: [],
              forbidden_traits: [],
              portrait: null,
              full_body: null,
              model_3d: null,
            },
            policy: {
              may_delegate: false,
              may_create_tasks: false,
              may_approve: false,
              may_veto: false,
              max_risk_level: "low",
              allowed_tools: [],
              requires_approval_for: [],
            },
          },
        ],
      }),
    );

    const agent = orchestrator.getAgent(companyId, "controller")!;
    const department = db.prepare("SELECT key FROM crew_departments WHERE id = ?").get(agent.department_id) as {
      key: string;
    };
    expect(department.key).toBe("finance");
  });

  it("refuses a second install rather than pretending it worked", () => {
    installer.install(companyId, testPack());
    expect(() => installer.install(companyId, testPack())).toThrow(PackMutationError);
  });

  it("records a receipt for every object it created", () => {
    const result = installer.install(companyId, testPack());
    const objects = new PackStore(db).objects(result.pack.id);
    expect(objects.map((o) => `${o.object_type}:${o.object_key}`).sort()).toEqual([
      "agent:desk",
      "department:service-desk",
      "routine:morning",
      "tool:test.inventory",
    ]);
  });

  it("writes an audit entry naming the pack and the person", () => {
    installer.install(companyId, testPack(), { actorId: "usr_robert" });
    const events = listAuditEvents(db, companyId, { limit: 20 }) as Array<{ action: string; actor_id: string }>;
    const event = events.find((e) => e.action === "pack.installed");
    expect(event?.actor_id).toBe("usr_robert");
  });
});

describe("rule 1 — reuse, never overwrite", () => {
  it("leaves a department the operator already had exactly as it was", () => {
    // The operator made this one themselves, before any pack existed.
    db.prepare(
      "INSERT INTO crew_departments (id, company_id, key, name, description, sort_order) VALUES (?,?,?,?,?,?)",
    ).run("dept_own", companyId, "service-desk", "Kundendienst", "Von Hand angelegt", 42);

    const result = installer.install(companyId, testPack());

    expect(result.reused.departments).toBe(1);
    expect(result.created.departments).toBe(0);
    const row = db
      .prepare("SELECT name, sort_order FROM crew_departments WHERE company_id = ? AND key = ?")
      .get(companyId, "service-desk") as { name: string; sort_order: number };
    expect(row.name).toBe("Kundendienst");
    expect(row.sort_order).toBe(42);
  });

  it("does not remove a department it did not create", () => {
    db.prepare(
      "INSERT INTO crew_departments (id, company_id, key, name, description, sort_order) VALUES (?,?,?,?,?,?)",
    ).run("dept_own", companyId, "service-desk", "Kundendienst", "Von Hand angelegt", 42);
    installer.install(companyId, testPack());

    installer.uninstall(companyId, "test-trade");
    // No receipt was written for it, so uninstall never touches it — even
    // though it is now empty.
    expect(db.prepare("SELECT id FROM crew_departments WHERE id = ?").get("dept_own")).toBeTruthy();
  });

  it("does not touch an existing post whose key is taken", () => {
    // The seeded company already has a "finance" agent named Ledger.
    const pack = testPack({
      departments: [],
      agents: [
        {
          key: "finance",
          department: "finance",
          professional_role: "Etwas anderes",
          role_summary: "Sollte nie gewinnen.",
          seniority: "junior",
          is_executive_assistant: false,
          runtime_profile: "balanced",
          skin: {
            display_name: "Fremdname",
            accent: "cyan",
            traits: [],
            forbidden_traits: [],
            portrait: null,
            full_body: null,
            model_3d: null,
          },
          policy: {
            may_delegate: false,
            may_create_tasks: false,
            may_approve: false,
            may_veto: false,
            max_risk_level: "low",
            allowed_tools: [],
            requires_approval_for: [],
          },
        },
      ],
    });
    const before = orchestrator.getAgent(companyId, "finance")!.display_name;
    const result = installer.install(companyId, pack);

    expect(result.reused.agents).toBe(1);
    expect(orchestrator.getAgent(companyId, "finance")!.display_name).toBe(before);
  });

  it("does not claim an object a different pack already owns", () => {
    installer.install(companyId, testPack());
    const other = testPack({ key: "other-trade" });
    const result = installer.install(companyId, other);

    // Everything was already there, so nothing is created and nothing is
    // recorded — uninstalling "other-trade" must not take the first pack's
    // department away.
    expect(result.created).toEqual({ departments: 0, agents: 0, tools: 0, routines: 0 });
    expect(new PackStore(db).objects(result.pack.id)).toHaveLength(0);

    installer.uninstall(companyId, "other-trade");
    expect(orchestrator.getAgent(companyId, "desk")).not.toBeNull();
  });
});

describe("rule 2 — registering is not granting", () => {
  it("registers the tool without granting it to anybody", () => {
    installer.install(companyId, testPack());
    const tools = new ToolStore(db);
    const tool = tools.byKey(companyId, "test.inventory")!;

    expect(tool.origin).toBe("pack");
    expect(tools.grantsFor(tool.id)).toHaveLength(0);

    // And the gate still refuses, which is the property that matters.
    const agent = orchestrator.getAgent(companyId, "desk")!;
    expect(tools.resolve(companyId, agent.id, "test.inventory").allowed).toBe(false);
  });
});

describe("rule 3 — a routine does not start itself", () => {
  it("installs the routine disabled", () => {
    installer.install(companyId, testPack());
    const routine = new RoutineStore(db).list(companyId).find((r) => r.name === "Morgendliche Sichtung")!;
    expect(routine.enabled).toBe(0);
  });
});

describe("uninstalling", () => {
  it("removes the routine, disables the tool and deletes the unused post", () => {
    installer.install(companyId, testPack());
    const result = installer.uninstall(companyId, "test-trade");

    expect(result.removed).toEqual({ departments: 1, agents: 1, tools: 0, routines: 1 });
    expect(result.disabledTools).toBe(1);
    expect(result.kept).toHaveLength(0);
    expect(orchestrator.getAgent(companyId, "desk")).toBeNull();
    expect(new ToolStore(db).byKey(companyId, "test.inventory")?.enabled).toBe(0);
  });

  it("keeps a post that has already worked, and says why", () => {
    installer.install(companyId, testPack());
    const agent = orchestrator.getAgent(companyId, "desk")!;
    orchestrator.tasks.create({
      companyId,
      title: "Störung aufnehmen",
      description: "Eine echte Aufgabe an diesem Posten.",
      assignedAgentId: agent.id,
    });

    const result = installer.uninstall(companyId, "test-trade");
    expect(result.removed.agents).toBe(0);
    expect(result.kept.map((k) => k.key)).toContain("desk");
    // Singular and plural both read like German, because an operator reads
    // this line at the moment they are surprised by it.
    expect(result.kept[0]?.reason).toBe("Es hängt noch eine Aufgabe an diesem Posten.");
    // The post survives, so the board still says who did the work.
    expect(orchestrator.getAgent(companyId, "desk")).not.toBeNull();
  });

  it("keeps the department while it still holds that post", () => {
    installer.install(companyId, testPack());
    const agent = orchestrator.getAgent(companyId, "desk")!;
    orchestrator.tasks.create({ companyId, title: "x", description: "y", assignedAgentId: agent.id });

    const result = installer.uninstall(companyId, "test-trade");
    expect(result.removed.departments).toBe(0);
    expect(result.kept.map((k) => k.type)).toContain("department");
  });

  it("never deletes a tool, because that would orphan every grant", () => {
    installer.install(companyId, testPack());
    const tools = new ToolStore(db);
    const tool = tools.byKey(companyId, "test.inventory")!;
    const agent = orchestrator.getAgent(companyId, "desk")!;
    tools.grant({ toolId: tool.id, agentId: agent.id });

    installer.uninstall(companyId, "test-trade");
    expect(tools.byKey(companyId, "test.inventory")).not.toBeNull();
    expect(tools.grantsFor(tool.id)).toHaveLength(1);
  });

  it("refuses to uninstall something that is not installed", () => {
    expect(() => installer.uninstall(companyId, "test-trade")).toThrow(PackMutationError);
  });

  it("can be installed again afterwards", () => {
    installer.install(companyId, testPack());
    installer.uninstall(companyId, "test-trade");
    expect(() => installer.install(companyId, testPack())).not.toThrow();
  });
});

describe("atomic pack installation", () => {
  it.each(BUSINESS_PACKS)("fully installs the shipped $key pack with all routines disabled", (pack) => {
    const result = installer.install(companyId, pack);
    expect(result.pack.pack_key).toBe(pack.key);
    const routines = new RoutineStore(db).list(companyId);
    for (const definition of pack.routines) {
      expect(routines.find((routine) => routine.name === definition.name)).toMatchObject({
        enabled: 0,
        interval_minutes: definition.interval_minutes,
      });
    }
  });

  it("rolls back pack, agents, tools, routines and audits if a later routine fails", () => {
    const tables = [
      "crew_packs",
      "crew_pack_objects",
      "crew_departments",
      "crew_agents",
      "crew_tools",
      "crew_routines",
      "crew_audit_events",
    ];
    const counts = () => tables.map((table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n);
    const before = counts();
    const bad = testPack({
      routines: [
        testPack().routines[0]!,
        { key: "bad", name: "Unsupported interval", instruction: "Test", interval_minutes: 60 * 24 * 366 },
      ],
    });
    expect(() => installer.install(companyId, bad)).toThrow(/Kalender/);
    expect(counts()).toEqual(before);
    expect(installer.isInstalled(companyId, bad.key)).toBe(false);
    expect(installer.install(companyId, testPack()).created.agents).toBe(1);
  });
});
