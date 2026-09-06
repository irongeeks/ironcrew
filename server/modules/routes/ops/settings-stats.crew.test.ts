import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { registerOpsSettingsStatsRoutes } from "./settings-stats.ts";

describe("canonical roster statistics", () => {
  it("counts Crew agents without mixing legacy agents and identifies legacy task metrics", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE agents (id TEXT PRIMARY KEY, status TEXT);
        CREATE TABLE crew_agents (id TEXT PRIMARY KEY, status TEXT);
        CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, status TEXT, department_id TEXT, workflow_pack_key TEXT);
        CREATE TABLE departments (id TEXT PRIMARY KEY, name TEXT, icon TEXT, color TEXT, sort_order INTEGER);
        CREATE TABLE task_logs (id TEXT PRIMARY KEY, task_id TEXT, created_at INTEGER);
        INSERT INTO agents VALUES ('legacy', 'working');
        INSERT INTO crew_agents VALUES ('crew-1', 'working'), ('crew-2', 'thinking'), ('crew-3', 'idle'), ('crew-4', 'offline');
        INSERT INTO tasks VALUES ('legacy-task', 'Earlier task', 'done', NULL, 'development');
      `);
      const routes = new Map<string, (req: unknown, res: unknown) => unknown>();
      const app = {
        get: (route: string, handler: (req: unknown, res: unknown) => unknown) => routes.set(route, handler),
        put: () => {},
      };
      registerOpsSettingsStatsRoutes({ app, db, nowMs: Date.now, broadcast: () => {} } as any);
      let response: any;
      const read = () => {
        routes.get("/api/stats")!(
          {},
          {
            json: (body: unknown) => {
              response = body;
            },
          },
        );
        return response.stats;
      };
      expect(read()).toMatchObject({
        agents: { total: 4, working: 2, idle: 1 },
        legacy_agents: { total: 1, working: 1, idle: 0 },
        tasks: { total: 1, done: 1, completion_rate: 100 },
        sources: { agents: "crew_agents", tasks: "tasks", recent_activity: "task_logs" },
      });
      db.exec("DELETE FROM crew_agents");
      expect(read().agents).toEqual({ total: 0, working: 0, idle: 0 });
      db.exec("DROP TABLE crew_agents");
      expect(read()).toMatchObject({
        agents: { total: 1, working: 1, idle: 0 },
        sources: { agents: "agents" },
      });
    } finally {
      db.close();
    }
  });
});
