import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  normalizeServerType,
  inferRequestedServerType,
  listServerTypePresets,
  requestServerAccess,
  releaseServerAccess,
  processQueuedServerAllocations,
  SERVER_TYPES,
} from "../../../modules/workflow/orchestration/server-allocation.ts";

// ---------------------------------------------------------------------------
// Mock external modules
// ---------------------------------------------------------------------------

vi.mock("../../../security/ssrf.ts", () => ({
  isBlockedSsrfTarget: vi.fn(() => false),
}));

// ---------------------------------------------------------------------------
// Mock DB helper
// ---------------------------------------------------------------------------

interface MockRow {
  [key: string]: unknown;
}

function createMockDb() {
  const store: {
    servers: MockRow[];
    server_allocations: MockRow[];
    agent_server_access: MockRow[];
  } = {
    servers: [],
    server_allocations: [],
    agent_server_access: [],
  };

  return {
    _store: store,

    addServer(row: MockRow) {
      store.servers.push(row);
    },

    addAllocation(row: MockRow) {
      store.server_allocations.push(row);
    },

    addAgentAccess(row: MockRow) {
      store.agent_server_access.push(row);
    },

    prepare(sql: string) {
      const trimmed = sql.trim().toUpperCase();

      return {
        get(...params: unknown[]): MockRow | undefined {
          // server_allocations existing check
          if (
            trimmed.includes("FROM SERVER_ALLOCATIONS") &&
            trimmed.includes("TASK_ID") &&
            trimmed.includes("REQUESTED_SERVER_TYPE") &&
            trimmed.includes("STATUS IN")
          ) {
            const taskId = params[0] as string;
            const serverType = params[1] as string;
            return store.server_allocations.find(
              (a) =>
                a.task_id === taskId &&
                a.requested_server_type === serverType &&
                (a.status === "queued" || a.status === "active"),
            );
          }

          // Queue position count
          if (trimmed.includes("COUNT(*)") && trimmed.includes("SERVER_ALLOCATIONS") && trimmed.includes("QUEUED")) {
            if (trimmed.includes("REQUESTED_AT <=")) {
              // positional queue count for specific allocation
              const serverType = params[0] as string;
              const allocationId = params[1] as string;
              const targetAlloc = store.server_allocations.find((a) => a.id === allocationId);
              if (!targetAlloc) return { cnt: 1 };
              const cnt = store.server_allocations.filter(
                (a) =>
                  a.requested_server_type === serverType &&
                  a.status === "queued" &&
                  (a.requested_at as number) <= (targetAlloc.requested_at as number),
              ).length;
              return { cnt };
            }
            const serverType = params[0] as string;
            const cnt = store.server_allocations.filter(
              (a) => a.requested_server_type === serverType && a.status === "queued",
            ).length;
            return { cnt };
          }

          // Find available server
          if (
            trimmed.includes("FROM SERVERS") &&
            trimmed.includes("ENABLED") &&
            trimmed.includes("CURRENT_JOBS < MAX_CONCURRENT_JOBS")
          ) {
            const serverType = params[0] as string;
            // Remaining params are allowed server IDs (if any)
            const allowedIds = params.slice(1) as string[];
            return store.servers.find((s) => {
              if (Number(s.enabled) !== 1) return false;
              if (s.type !== serverType) return false;
              if (s.status === "offline") return false;
              if ((s.current_jobs as number) >= (s.max_concurrent_jobs as number)) return false;
              if (allowedIds.length > 0 && !allowedIds.includes(s.id as string)) return false;
              return true;
            });
          }

          // Single server lookup for release
          if (trimmed.includes("FROM SERVERS") && trimmed.includes("WHERE ID")) {
            const serverId = params[0] as string;
            return store.servers.find((s) => s.id === serverId);
          }

          return undefined;
        },

        all(...params: unknown[]): MockRow[] {
          // Agent server access
          if (trimmed.includes("FROM AGENT_SERVER_ACCESS")) {
            const agentId = params[0] as string;
            return store.agent_server_access.filter((a) => a.agent_id === agentId).map((r) => ({ ...r }));
          }

          // Queued allocations for processQueuedServerAllocations
          if (trimmed.includes("FROM SERVER_ALLOCATIONS") && trimmed.includes("STATUS = 'QUEUED'")) {
            return store.server_allocations.filter((a) => a.status === "queued").map((r) => ({ ...r }));
          }

          // Release: find active/queued allocations for task
          if (
            trimmed.includes("FROM SERVER_ALLOCATIONS") &&
            trimmed.includes("TASK_ID") &&
            trimmed.includes("STATUS IN")
          ) {
            const taskId = params[0] as string;
            const agentId = params.length > 1 ? (params[1] as string) : null;
            return store.server_allocations
              .filter((a) => {
                if (a.task_id !== taskId) return false;
                if (a.status !== "queued" && a.status !== "active") return false;
                if (agentId && a.agent_id !== agentId) return false;
                return true;
              })
              .map((r) => ({ ...r }));
          }

          return [];
        },

        run(...params: unknown[]) {
          // INSERT into server_allocations
          if (trimmed.includes("INSERT INTO SERVER_ALLOCATIONS") && trimmed.includes("'ACTIVE'")) {
            store.server_allocations.push({
              id: params[0],
              server_id: params[1],
              task_id: params[2],
              agent_id: params[3],
              requested_server_type: params[4],
              status: "active",
              requested_at: params[5],
              started_at: params[6],
            });
          } else if (trimmed.includes("INSERT INTO SERVER_ALLOCATIONS") && trimmed.includes("'QUEUED'")) {
            store.server_allocations.push({
              id: params[0],
              server_id: null,
              task_id: params[1],
              agent_id: params[2],
              requested_server_type: params[3],
              status: "queued",
              queue_reason: params[4],
              requested_at: params[5],
            });
          }

          // UPDATE servers
          if (trimmed.includes("UPDATE SERVERS SET CURRENT_JOBS")) {
            const serverId = params[params.length - 1] as string;
            const server = store.servers.find((s) => s.id === serverId);
            if (server) {
              server.current_jobs = params[0];
              server.status = params[1];
            }
          }

          // UPDATE server_allocations SET status = 'released'
          if (trimmed.includes("UPDATE SERVER_ALLOCATIONS SET STATUS = 'RELEASED'")) {
            const allocId = params[params.length - 1] as string;
            const alloc = store.server_allocations.find((a) => a.id === allocId);
            if (alloc) alloc.status = "released";
          }

          // UPDATE server_allocations SET status = 'active' (processQueued)
          if (trimmed.includes("UPDATE SERVER_ALLOCATIONS SET STATUS = 'ACTIVE'")) {
            const allocId = params[params.length - 1] as string;
            const alloc = store.server_allocations.find((a) => a.id === allocId);
            if (alloc) {
              alloc.status = "active";
              alloc.server_id = params[0];
            }
          }

          return { changes: 1 };
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Tests: normalizeServerType
// ---------------------------------------------------------------------------

describe("normalizeServerType", () => {
  it("returns valid server type for known types", () => {
    expect(normalizeServerType("comfyui")).toBe("comfyui");
    expect(normalizeServerType("llm_api")).toBe("llm_api");
    expect(normalizeServerType("database")).toBe("database");
    expect(normalizeServerType("file_storage")).toBe("file_storage");
    expect(normalizeServerType("ssh_remote")).toBe("ssh_remote");
  });

  it("handles case-insensitive input", () => {
    expect(normalizeServerType("ComfyUI")).toBe("comfyui");
    expect(normalizeServerType("LLM_API")).toBe("llm_api");
  });

  it("trims whitespace", () => {
    expect(normalizeServerType("  comfyui  ")).toBe("comfyui");
  });

  it("returns null for invalid types", () => {
    expect(normalizeServerType("invalid")).toBeNull();
    expect(normalizeServerType("")).toBeNull();
    expect(normalizeServerType(null)).toBeNull();
    expect(normalizeServerType(undefined)).toBeNull();
    expect(normalizeServerType(42)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests: inferRequestedServerType
// ---------------------------------------------------------------------------

describe("inferRequestedServerType", () => {
  it("uses explicit type when provided", () => {
    expect(inferRequestedServerType({ explicitType: "comfyui" })).toBe("comfyui");
  });

  it("infers comfyui from task types", () => {
    expect(inferRequestedServerType({ taskType: "mockup design" })).toBe("comfyui");
    expect(inferRequestedServerType({ taskType: "image generation" })).toBe("comfyui");
    expect(inferRequestedServerType({ taskType: "design review" })).toBe("comfyui");
  });

  it("infers llm_api only from 'api' provider", () => {
    expect(inferRequestedServerType({ provider: "api" })).toBe("llm_api");
  });

  it("does not infer llm_api from CLI providers", () => {
    expect(inferRequestedServerType({ provider: "claude" })).toBeNull();
    expect(inferRequestedServerType({ provider: "codex" })).toBeNull();
    expect(inferRequestedServerType({ provider: "gemini" })).toBeNull();
  });

  it("reads server type from workflowMetaJson", () => {
    const meta = JSON.stringify({ server_type: "database" });
    expect(inferRequestedServerType({ workflowMetaJson: meta })).toBe("database");
  });

  it("reads serverType (camelCase) from workflowMetaJson", () => {
    const meta = JSON.stringify({ serverType: "file_storage" });
    expect(inferRequestedServerType({ workflowMetaJson: meta })).toBe("file_storage");
  });

  it("ignores malformed JSON in workflowMetaJson", () => {
    expect(inferRequestedServerType({ workflowMetaJson: "not-json" })).toBeNull();
  });

  it("returns null when no signals present", () => {
    expect(inferRequestedServerType({})).toBeNull();
  });

  it("explicit type takes precedence over inference", () => {
    expect(inferRequestedServerType({ explicitType: "database", provider: "api", taskType: "mockup" })).toBe(
      "database",
    );
  });
});

// ---------------------------------------------------------------------------
// Tests: listServerTypePresets
// ---------------------------------------------------------------------------

describe("listServerTypePresets", () => {
  it("returns preset for each server type", () => {
    const presets = listServerTypePresets();
    expect(presets).toHaveLength(SERVER_TYPES.length);
    for (const type of SERVER_TYPES) {
      expect(presets.find((p) => p.type === type)).toBeDefined();
    }
  });

  it("each preset has required fields", () => {
    const presets = listServerTypePresets();
    for (const preset of presets) {
      expect(preset.label).toBeTruthy();
      expect(preset.description).toBeTruthy();
      expect(preset.examples.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: requestServerAccess
// ---------------------------------------------------------------------------

describe("requestServerAccess", () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    db = createMockDb();
  });

  it("returns skipped when requestedServerType is null", () => {
    const result = requestServerAccess(db as any, {
      nowMs: 1000,
      taskId: "task-1",
      agentId: "agent-1",
      requestedServerType: null,
    });
    expect(result.state).toBe("skipped");
  });

  it("returns existing active allocation if present", () => {
    db.addAllocation({
      id: "alloc-1",
      task_id: "task-1",
      requested_server_type: "comfyui",
      status: "active",
      server_id: "server-1",
      requested_at: 500,
    });

    const result = requestServerAccess(db as any, {
      nowMs: 1000,
      taskId: "task-1",
      agentId: "agent-1",
      requestedServerType: "comfyui",
    });
    expect(result.state).toBe("allocated");
    if (result.state === "allocated") {
      expect(result.allocation_id).toBe("alloc-1");
      expect(result.server_id).toBe("server-1");
    }
  });

  it("returns existing queued allocation with queue position", () => {
    db.addAllocation({
      id: "alloc-q1",
      task_id: "task-1",
      requested_server_type: "comfyui",
      status: "queued",
      server_id: null,
      requested_at: 500,
    });

    const result = requestServerAccess(db as any, {
      nowMs: 1000,
      taskId: "task-1",
      agentId: "agent-1",
      requestedServerType: "comfyui",
    });
    expect(result.state).toBe("queued");
    if (result.state === "queued") {
      expect(result.allocation_id).toBe("alloc-q1");
      expect(result.queue_position).toBeGreaterThanOrEqual(1);
    }
  });

  it("allocates to available server when one exists", () => {
    db.addServer({
      id: "server-1",
      type: "comfyui",
      enabled: 1,
      status: "idle",
      current_jobs: 0,
      max_concurrent_jobs: 2,
    });

    const result = requestServerAccess(db as any, {
      nowMs: 1000,
      taskId: "task-1",
      agentId: "agent-1",
      requestedServerType: "comfyui",
    });
    expect(result.state).toBe("allocated");
    if (result.state === "allocated") {
      expect(result.server_id).toBe("server-1");
      expect(result.requested_server_type).toBe("comfyui");
    }

    // Server should have jobs incremented
    const server = db._store.servers.find((s) => s.id === "server-1");
    expect(server?.current_jobs).toBe(1);
  });

  it("queues when no servers are available", () => {
    const result = requestServerAccess(db as any, {
      nowMs: 1000,
      taskId: "task-1",
      agentId: "agent-1",
      requestedServerType: "comfyui",
      queueReason: "no_server",
    });
    expect(result.state).toBe("queued");
    if (result.state === "queued") {
      expect(result.queue_position).toBeGreaterThanOrEqual(1);
    }
  });

  it("queues when all servers are at capacity", () => {
    db.addServer({
      id: "server-1",
      type: "comfyui",
      enabled: 1,
      status: "busy",
      current_jobs: 2,
      max_concurrent_jobs: 2,
    });

    const result = requestServerAccess(db as any, {
      nowMs: 1000,
      taskId: "task-1",
      agentId: "agent-1",
      requestedServerType: "comfyui",
    });
    expect(result.state).toBe("queued");
  });

  it("does not allocate offline servers", () => {
    db.addServer({
      id: "server-1",
      type: "comfyui",
      enabled: 1,
      status: "offline",
      current_jobs: 0,
      max_concurrent_jobs: 2,
    });

    const result = requestServerAccess(db as any, {
      nowMs: 1000,
      taskId: "task-1",
      agentId: "agent-1",
      requestedServerType: "comfyui",
    });
    expect(result.state).toBe("queued");
  });

  it("updates server status to busy when at capacity after allocation", () => {
    db.addServer({
      id: "server-1",
      type: "comfyui",
      enabled: 1,
      status: "idle",
      current_jobs: 1,
      max_concurrent_jobs: 2,
    });

    requestServerAccess(db as any, {
      nowMs: 1000,
      taskId: "task-1",
      agentId: "agent-1",
      requestedServerType: "comfyui",
    });

    const server = db._store.servers.find((s) => s.id === "server-1");
    expect(server?.current_jobs).toBe(2);
    expect(server?.status).toBe("busy");
  });
});

// ---------------------------------------------------------------------------
// Tests: releaseServerAccess
// ---------------------------------------------------------------------------

describe("releaseServerAccess", () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    db = createMockDb();
  });

  it("returns zero released when no allocations exist", () => {
    const result = releaseServerAccess(db as any, {
      nowMs: 1000,
      taskId: "task-1",
    });
    expect(result.released_allocations).toBe(0);
    expect(result.touched_server_ids).toHaveLength(0);
  });

  it("releases active allocations and decrements server jobs", () => {
    db.addServer({
      id: "server-1",
      type: "comfyui",
      enabled: 1,
      status: "busy",
      current_jobs: 2,
      max_concurrent_jobs: 2,
    });
    db.addAllocation({
      id: "alloc-1",
      task_id: "task-1",
      server_id: "server-1",
      status: "active",
      requested_server_type: "comfyui",
    });

    const result = releaseServerAccess(db as any, {
      nowMs: 1000,
      taskId: "task-1",
      reason: "task_completed",
    });

    expect(result.released_allocations).toBe(1);
    expect(result.touched_server_ids).toContain("server-1");

    const alloc = db._store.server_allocations.find((a) => a.id === "alloc-1");
    expect(alloc?.status).toBe("released");

    const server = db._store.servers.find((s) => s.id === "server-1");
    expect(server?.current_jobs).toBe(1);
    expect(server?.status).toBe("idle");
  });

  it("releases queued allocations without touching servers", () => {
    db.addAllocation({
      id: "alloc-q1",
      task_id: "task-1",
      server_id: null,
      status: "queued",
      requested_server_type: "comfyui",
    });

    const result = releaseServerAccess(db as any, {
      nowMs: 1000,
      taskId: "task-1",
    });

    expect(result.released_allocations).toBe(1);
    expect(result.touched_server_ids).toHaveLength(0);
  });

  it("filters by agentId when provided", () => {
    db.addAllocation({
      id: "alloc-a1",
      task_id: "task-1",
      agent_id: "agent-1",
      server_id: null,
      status: "queued",
      requested_server_type: "comfyui",
    });
    db.addAllocation({
      id: "alloc-a2",
      task_id: "task-1",
      agent_id: "agent-2",
      server_id: null,
      status: "queued",
      requested_server_type: "comfyui",
    });

    const result = releaseServerAccess(db as any, {
      nowMs: 1000,
      taskId: "task-1",
      agentId: "agent-1",
    });

    expect(result.released_allocations).toBe(1);
    const allocA2 = db._store.server_allocations.find((a) => a.id === "alloc-a2");
    expect(allocA2?.status).toBe("queued"); // should not be released
  });

  it("preserves offline status on server after release", () => {
    db.addServer({
      id: "server-1",
      type: "comfyui",
      enabled: 1,
      status: "offline",
      current_jobs: 1,
      max_concurrent_jobs: 2,
    });
    db.addAllocation({
      id: "alloc-1",
      task_id: "task-1",
      server_id: "server-1",
      status: "active",
      requested_server_type: "comfyui",
    });

    releaseServerAccess(db as any, { nowMs: 1000, taskId: "task-1" });

    const server = db._store.servers.find((s) => s.id === "server-1");
    expect(server?.status).toBe("offline");
  });
});

// ---------------------------------------------------------------------------
// Tests: processQueuedServerAllocations
// ---------------------------------------------------------------------------

describe("processQueuedServerAllocations", () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    db = createMockDb();
  });

  it("returns empty array when no queued allocations exist", () => {
    const result = processQueuedServerAllocations(db as any, 1000);
    expect(result).toHaveLength(0);
  });

  it("activates queued allocations when servers become available", () => {
    db.addServer({
      id: "server-1",
      type: "comfyui",
      enabled: 1,
      status: "idle",
      current_jobs: 0,
      max_concurrent_jobs: 2,
    });
    db.addAllocation({
      id: "alloc-q1",
      task_id: "task-1",
      agent_id: "agent-1",
      server_id: null,
      status: "queued",
      requested_server_type: "comfyui",
      requested_at: 500,
    });

    const result = processQueuedServerAllocations(db as any, 1000);

    expect(result).toHaveLength(1);
    expect(result[0].allocation_id).toBe("alloc-q1");
    expect(result[0].server_id).toBe("server-1");
    expect(result[0].task_id).toBe("task-1");
    expect(result[0].agent_id).toBe("agent-1");

    const alloc = db._store.server_allocations.find((a) => a.id === "alloc-q1");
    expect(alloc?.status).toBe("active");
  });

  it("skips queued allocations when no matching server available", () => {
    db.addAllocation({
      id: "alloc-q1",
      task_id: "task-1",
      agent_id: "agent-1",
      server_id: null,
      status: "queued",
      requested_server_type: "comfyui",
      requested_at: 500,
    });

    const result = processQueuedServerAllocations(db as any, 1000);
    expect(result).toHaveLength(0);
  });
});
