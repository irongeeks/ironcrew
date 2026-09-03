import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { SkillLearnJob } from "../../../../modules/routes/ops/skills/types.ts";

// ---------------------------------------------------------------------------
// Mock learn-core so we can control all route dependencies
// ---------------------------------------------------------------------------

const mockSkillLearnJobs = new Map<string, SkillLearnJob>();
const mockPruneSkillLearnJobs = vi.fn();
const mockPruneSkillLearningHistory = vi.fn();
const mockCreateSkillLearnJob = vi.fn<(repo: string, skillId: string, providers: string[]) => SkillLearnJob>();
const mockRunSkillUnlearnForProvider = vi.fn();

vi.mock("../../../../modules/routes/ops/skills/learn-core.ts", () => ({
  createSkillLearnCore: () => ({
    SKILL_LEARN_REPO_RE: /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/,
    SKILL_LEARN_HISTORY_RETENTION_DAYS: 180,
    SKILL_LEARN_HISTORY_MAX_QUERY_LIMIT: 200,
    skillLearnJobs: mockSkillLearnJobs,
    normalizeSkillLearnProviders: (input: unknown) => {
      if (!Array.isArray(input)) return [];
      const valid = ["claude", "codex", "gemini", "opencode"];
      const out: string[] = [];
      for (const raw of input) {
        const v = String(raw ?? "")
          .trim()
          .toLowerCase();
        if (valid.includes(v) && !out.includes(v)) out.push(v);
      }
      return out;
    },
    isSkillHistoryProvider: (v: string) =>
      ["claude", "codex", "gemini", "opencode", "copilot", "antigravity", "api", "browser"].includes(v),
    normalizeSkillLearnStatus: (v: string) => (["queued", "running", "succeeded", "failed"].includes(v) ? v : null),
    normalizeSkillLearnSkillId: (skillId: string, repo: string) => {
      const trimmed = skillId.trim();
      if (trimmed) return trimmed;
      const tail = repo.split("/").filter(Boolean).pop();
      return tail || "unknown-skill";
    },
    pruneSkillLearnJobs: mockPruneSkillLearnJobs,
    pruneSkillLearningHistory: mockPruneSkillLearningHistory,
    createSkillLearnJob: mockCreateSkillLearnJob,
    runSkillUnlearnForProvider: mockRunSkillUnlearnForProvider,
  }),
}));

// ---------------------------------------------------------------------------
// Mock DB
// ---------------------------------------------------------------------------

const mockDbAllRows: unknown[] = [];
const mockDbRunResult = { changes: 0 };

function createMockDb() {
  return {
    prepare: () => ({
      all: (..._params: unknown[]) => mockDbAllRows,
      run: (..._params: unknown[]) => mockDbRunResult,
      get: () => undefined,
    }),
  };
}

// ---------------------------------------------------------------------------
// App setup
// ---------------------------------------------------------------------------

import { registerSkillLearnRoutes } from "../../../../modules/routes/ops/skills/learn-routes.ts";

function createTestApp() {
  const app = express();
  app.use(express.json());
  const db = createMockDb();

  const ctx = { app, db } as any;
  const result = registerSkillLearnRoutes(ctx);
  return { app, db, result };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Skill Learn Routes", () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSkillLearnJobs.clear();
    mockDbAllRows.length = 0;
    mockDbRunResult.changes = 0;
    const testApp = createTestApp();
    app = testApp.app;
  });

  // =========================================================================
  // POST /api/skills/learn
  // =========================================================================

  describe("POST /api/skills/learn", () => {
    it("returns 202 with job on valid request", async () => {
      const fakeJob: SkillLearnJob = {
        id: "job-123",
        repo: "owner/repo",
        skillId: "my-skill",
        providers: ["claude"],
        agents: ["claude-code"],
        status: "queued",
        command: "npx --yes skills@latest add owner/repo --yes --agent claude-code",
        createdAt: Date.now(),
        startedAt: null,
        completedAt: null,
        updatedAt: Date.now(),
        exitCode: null,
        logTail: [],
        error: null,
      };
      mockCreateSkillLearnJob.mockReturnValue(fakeJob);

      const res = await request(app)
        .post("/api/skills/learn")
        .send({ repo: "owner/repo", skillId: "my-skill", providers: ["claude"] });

      expect(res.status).toBe(202);
      expect(res.body.ok).toBe(true);
      expect(res.body.job).toEqual(fakeJob);
      expect(mockPruneSkillLearnJobs).toHaveBeenCalled();
      expect(mockCreateSkillLearnJob).toHaveBeenCalledWith("owner/repo", "my-skill", ["claude"]);
    });

    it("returns 400 when repo is missing", async () => {
      const res = await request(app)
        .post("/api/skills/learn")
        .send({ providers: ["claude"] });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("repo required");
    });

    it("returns 400 when repo is empty string", async () => {
      const res = await request(app)
        .post("/api/skills/learn")
        .send({ repo: "  ", providers: ["claude"] });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("repo required");
    });

    it("returns 400 when repo format is invalid", async () => {
      const res = await request(app)
        .post("/api/skills/learn")
        .send({ repo: "not a valid repo!", providers: ["claude"] });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid repo format");
    });

    it("returns 400 when providers is empty", async () => {
      const res = await request(app).post("/api/skills/learn").send({ repo: "owner/repo", providers: [] });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("providers required");
    });

    it("returns 400 when providers are all invalid", async () => {
      const res = await request(app)
        .post("/api/skills/learn")
        .send({ repo: "owner/repo", providers: ["invalid-provider"] });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("providers required");
    });

    it("returns 400 when providers is not an array", async () => {
      const res = await request(app).post("/api/skills/learn").send({ repo: "owner/repo", providers: "claude" });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("providers required");
    });

    it("accepts multi-segment repo paths", async () => {
      const fakeJob: SkillLearnJob = {
        id: "job-456",
        repo: "owner/repo/sub",
        skillId: "sub",
        providers: ["gemini"],
        agents: ["gemini-cli"],
        status: "queued",
        command: "npx --yes skills@latest add owner/repo/sub --yes --agent gemini-cli",
        createdAt: Date.now(),
        startedAt: null,
        completedAt: null,
        updatedAt: Date.now(),
        exitCode: null,
        logTail: [],
        error: null,
      };
      mockCreateSkillLearnJob.mockReturnValue(fakeJob);

      const res = await request(app)
        .post("/api/skills/learn")
        .send({ repo: "owner/repo/sub", skillId: "", providers: ["gemini"] });

      expect(res.status).toBe(202);
      expect(res.body.ok).toBe(true);
    });
  });

  // =========================================================================
  // GET /api/skills/learn/:jobId
  // =========================================================================

  describe("GET /api/skills/learn/:jobId", () => {
    it("returns job when found", async () => {
      const fakeJob: SkillLearnJob = {
        id: "job-789",
        repo: "owner/repo",
        skillId: "my-skill",
        providers: ["claude"],
        agents: ["claude-code"],
        status: "running",
        command: "npx --yes skills@latest add owner/repo --yes --agent claude-code",
        createdAt: Date.now(),
        startedAt: Date.now(),
        completedAt: null,
        updatedAt: Date.now(),
        exitCode: null,
        logTail: ["line1"],
        error: null,
      };
      mockSkillLearnJobs.set("job-789", fakeJob);

      const res = await request(app).get("/api/skills/learn/job-789");

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.job.id).toBe("job-789");
      expect(res.body.job.status).toBe("running");
      expect(mockPruneSkillLearnJobs).toHaveBeenCalled();
    });

    it("returns 404 when job not found", async () => {
      const res = await request(app).get("/api/skills/learn/nonexistent-id");

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("job_not_found");
    });
  });

  // =========================================================================
  // GET /api/skills/history
  // =========================================================================

  describe("GET /api/skills/history", () => {
    it("returns history with default limit", async () => {
      const row = {
        id: "h1",
        job_id: "j1",
        provider: "claude",
        repo: "owner/repo",
        skill_id: "skill-1",
        skill_label: "owner/repo#skill-1",
        status: "succeeded",
        command: "npx ...",
        error: null,
        run_started_at: 1000,
        run_completed_at: 2000,
        created_at: 1000,
        updated_at: 2000,
      };
      mockDbAllRows.push(row);

      const res = await request(app).get("/api/skills/history");

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.retention_days).toBe(180);
      expect(res.body.history).toHaveLength(1);
      expect(res.body.history[0].id).toBe("h1");
      expect(mockPruneSkillLearningHistory).toHaveBeenCalled();
    });

    it("returns 400 for invalid provider", async () => {
      const res = await request(app).get("/api/skills/history?provider=invalid");

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid provider");
    });

    it("returns 400 for invalid status", async () => {
      const res = await request(app).get("/api/skills/history?status=bogus");

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid status");
    });

    it("accepts valid provider filter", async () => {
      const res = await request(app).get("/api/skills/history?provider=claude");

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it("accepts valid status filter", async () => {
      const res = await request(app).get("/api/skills/history?status=succeeded");

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it("accepts combined filters", async () => {
      const res = await request(app).get("/api/skills/history?provider=codex&status=failed&limit=10");

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it("clamps limit to max query limit", async () => {
      const res = await request(app).get("/api/skills/history?limit=9999");

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it("clamps limit to minimum of 1", async () => {
      const res = await request(app).get("/api/skills/history?limit=0");

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it("ignores empty provider and status", async () => {
      const res = await request(app).get("/api/skills/history?provider=&status=");

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });
  });

  // =========================================================================
  // GET /api/skills/available
  // =========================================================================

  describe("GET /api/skills/available", () => {
    it("returns available skills with defaults", async () => {
      const row = {
        provider: "claude",
        repo: "owner/repo",
        skill_id: "skill-1",
        skill_label: "owner/repo#skill-1",
        learned_at: 2000,
      };
      mockDbAllRows.push(row);

      const res = await request(app).get("/api/skills/available");

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.skills).toHaveLength(1);
      expect(res.body.skills[0].provider).toBe("claude");
      expect(mockPruneSkillLearningHistory).toHaveBeenCalled();
    });

    it("returns 400 for invalid provider", async () => {
      const res = await request(app).get("/api/skills/available?provider=invalid");

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid provider");
    });

    it("accepts valid provider filter", async () => {
      const res = await request(app).get("/api/skills/available?provider=gemini");

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it("accepts limit parameter", async () => {
      const res = await request(app).get("/api/skills/available?limit=5");

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it("ignores empty provider", async () => {
      const res = await request(app).get("/api/skills/available?provider=");

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });
  });

  // =========================================================================
  // POST /api/skills/unlearn
  // =========================================================================

  describe("POST /api/skills/unlearn", () => {
    it("returns success on valid unlearn request", async () => {
      mockRunSkillUnlearnForProvider.mockResolvedValue({
        ok: true,
        skipped: false,
        agent: "claude-code",
        removedSkill: "my-skill",
        message: "cli_skill_remove_ok",
        attempts: [],
      });
      mockDbRunResult.changes = 1;

      const res = await request(app)
        .post("/api/skills/unlearn")
        .send({ provider: "claude", repo: "owner/repo", skillId: "my-skill" });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.provider).toBe("claude");
      expect(res.body.repo).toBe("owner/repo");
      expect(res.body.skill_id).toBe("my-skill");
      expect(res.body.removed).toBe(1);
      expect(res.body.cli.agent).toBe("claude-code");
      expect(res.body.cli.skill).toBe("my-skill");
      expect(res.body.cli.message).toBe("cli_skill_remove_ok");
      expect(mockPruneSkillLearningHistory).toHaveBeenCalled();
    });

    it("returns 400 for invalid provider", async () => {
      const res = await request(app)
        .post("/api/skills/unlearn")
        .send({ provider: "invalid", repo: "owner/repo", skillId: "my-skill" });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid provider");
    });

    it("returns 400 for missing provider", async () => {
      const res = await request(app).post("/api/skills/unlearn").send({ repo: "owner/repo", skillId: "my-skill" });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid provider");
    });

    it("returns 400 for invalid repo format", async () => {
      const res = await request(app)
        .post("/api/skills/unlearn")
        .send({ provider: "claude", repo: "bad repo!", skillId: "my-skill" });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid repo format");
    });

    it("returns 400 for missing repo", async () => {
      const res = await request(app).post("/api/skills/unlearn").send({ provider: "claude", skillId: "my-skill" });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid repo format");
    });

    it("returns 409 when CLI unlearn fails", async () => {
      mockRunSkillUnlearnForProvider.mockResolvedValue({
        ok: false,
        skipped: false,
        agent: "claude-code",
        removedSkill: null,
        message: "cli_unlearn_verify_failed_fs_still_linked",
        attempts: [{ skill: "my-skill", output: "error output" }],
      });

      const res = await request(app)
        .post("/api/skills/unlearn")
        .send({ provider: "claude", repo: "owner/repo", skillId: "my-skill" });

      expect(res.status).toBe(409);
      expect(res.body.error).toBe("cli_unlearn_verify_failed_fs_still_linked");
      expect(res.body.code).toBe("cli_unlearn_failed");
      expect(res.body.provider).toBe("claude");
      expect(res.body.agent).toBe("claude-code");
    });

    it("accepts skill_id body field as alternative to skillId", async () => {
      mockRunSkillUnlearnForProvider.mockResolvedValue({
        ok: true,
        skipped: true,
        agent: "claude-code",
        removedSkill: null,
        message: "skill_already_unlinked",
        attempts: [],
      });
      mockDbRunResult.changes = 0;

      const res = await request(app)
        .post("/api/skills/unlearn")
        .send({ provider: "claude", repo: "owner/repo", skill_id: "alt-skill" });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.skill_id).toBe("alt-skill");
    });

    it("derives skillId from repo when not provided", async () => {
      mockRunSkillUnlearnForProvider.mockResolvedValue({
        ok: true,
        skipped: true,
        agent: "codex",
        removedSkill: null,
        message: "no_matching_installed_skill_found_for_unlearn",
        attempts: [],
      });
      mockDbRunResult.changes = 0;

      const res = await request(app).post("/api/skills/unlearn").send({ provider: "codex", repo: "owner/my-repo" });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      // skillId should be derived from last segment of repo
      expect(res.body.skill_id).toBe("my-repo");
    });

    it("accepts extended history providers like copilot", async () => {
      mockRunSkillUnlearnForProvider.mockResolvedValue({
        ok: true,
        skipped: true,
        agent: "github-copilot",
        removedSkill: null,
        message: "no_local_cli_agent_for_provider",
        attempts: [],
      });
      mockDbRunResult.changes = 0;

      const res = await request(app)
        .post("/api/skills/unlearn")
        .send({ provider: "copilot", repo: "owner/repo", skillId: "my-skill" });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });
  });

  // =========================================================================
  // normalizeSkillLearnProviders return value
  // =========================================================================

  describe("registerSkillLearnRoutes return value", () => {
    it("returns normalizeSkillLearnProviders function", () => {
      const testApp = createTestApp();
      expect(typeof testApp.result.normalizeSkillLearnProviders).toBe("function");
    });

    it("normalizeSkillLearnProviders filters valid providers", () => {
      const testApp = createTestApp();
      const result = testApp.result.normalizeSkillLearnProviders(["claude", "invalid", "gemini"]);
      expect(result).toEqual(["claude", "gemini"]);
    });

    it("normalizeSkillLearnProviders returns empty for non-array", () => {
      const testApp = createTestApp();
      const result = testApp.result.normalizeSkillLearnProviders("claude");
      expect(result).toEqual([]);
    });
  });
});
