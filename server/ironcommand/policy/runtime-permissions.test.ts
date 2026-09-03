import { describe, it, expect } from "vitest";
import {
  assertArgsMatchMode,
  clampGrantExpiry,
  containsDangerousFlag,
  MAX_SANDBOX_GRANT_MS,
  permissionArgsFor,
  PermissionPolicyError,
  resolvePermissionMode,
  type SandboxGrant,
} from "./runtime-permissions.ts";
import { claudeAdapter } from "../../adapters/claude.ts";
import { codexAdapter } from "../../adapters/codex.ts";
import { geminiAdapter } from "../../adapters/gemini.ts";

const NOW = 1_700_000_000_000;

function grant(overrides: Partial<SandboxGrant> = {}): SandboxGrant {
  return {
    grantId: "grant-1",
    companyId: "company-1",
    approvedBy: "owner-1",
    approvalId: "approval-1",
    reason: "one-off migration script",
    issuedAt: NOW,
    expiresAt: NOW + 60_000,
    providers: ["claude"],
    ...overrides,
  };
}

describe("default posture", () => {
  it("defaults to restricted with no grant", () => {
    const r = resolvePermissionMode({ provider: "claude", companyId: "company-1", now: NOW });
    expect(r.mode).toBe("restricted");
    expect(r.code).toBe("default_restricted");
  });

  it("workspace_write does not need a grant", () => {
    const r = resolvePermissionMode({
      provider: "claude",
      companyId: "company-1",
      requested: "workspace_write",
      now: NOW,
    });
    expect(r.mode).toBe("workspace_write");
  });
});

describe("elevation fails closed", () => {
  const base = { provider: "claude", companyId: "company-1", requested: "elevated" as const, now: NOW };

  it("denies elevation with no grant at all", () => {
    const r = resolvePermissionMode({ ...base });
    expect(r.mode).toBe("restricted");
    expect(r.code).toBe("grant_invalid");
  });

  it("denies elevation with a null grant", () => {
    expect(resolvePermissionMode({ ...base, grant: null }).mode).toBe("restricted");
  });

  it("denies a structurally invalid grant (missing approvalId)", () => {
    const bad = { ...grant() } as Record<string, unknown>;
    delete bad.approvalId;
    const r = resolvePermissionMode({ ...base, grant: bad as unknown as SandboxGrant });
    expect(r.mode).toBe("restricted");
    expect(r.code).toBe("grant_invalid");
  });

  it("denies an expired grant", () => {
    const r = resolvePermissionMode({ ...base, grant: grant(), now: NOW + 120_000 });
    expect(r.mode).toBe("restricted");
    expect(r.code).toBe("grant_expired");
  });

  it("enforces the hard maximum lifetime even if expiresAt is far in the future", () => {
    const g = grant({ expiresAt: NOW + 365 * 24 * 3600 * 1000 });
    const justInside = resolvePermissionMode({ ...base, grant: g, now: NOW + MAX_SANDBOX_GRANT_MS - 1 });
    expect(justInside.mode).toBe("elevated");
    const justOutside = resolvePermissionMode({ ...base, grant: g, now: NOW + MAX_SANDBOX_GRANT_MS });
    expect(justOutside.mode).toBe("restricted");
    expect(justOutside.code).toBe("grant_expired");
  });

  it("denies when the grant covers a different runtime", () => {
    const r = resolvePermissionMode({ ...base, provider: "codex", grant: grant() });
    expect(r.code).toBe("grant_provider_mismatch");
  });

  it("denies when the grant belongs to another company", () => {
    const r = resolvePermissionMode({ ...base, grant: grant({ companyId: "company-2" }) });
    expect(r.code).toBe("grant_company_mismatch");
  });

  it("denies when the grant is scoped to a different task", () => {
    const r = resolvePermissionMode({
      ...base,
      taskId: "task-b",
      grant: grant({ taskId: "task-a" }),
    });
    expect(r.code).toBe("grant_task_mismatch");
  });

  it("grants elevation only when every check passes", () => {
    const r = resolvePermissionMode({
      ...base,
      taskId: "task-a",
      grant: grant({ taskId: "task-a" }),
    });
    expect(r.mode).toBe("elevated");
    expect(r.grantId).toBe("grant-1");
    expect(r.reason).toContain("approval-1");
  });
});

describe("clampGrantExpiry", () => {
  it("caps an over-long request at the policy maximum", () => {
    expect(clampGrantExpiry(NOW, NOW + 999 * 3600_000)).toBe(NOW + MAX_SANDBOX_GRANT_MS);
  });
  it("leaves a short request untouched", () => {
    expect(clampGrantExpiry(NOW, NOW + 1000)).toBe(NOW + 1000);
  });
});

describe("per-provider argv", () => {
  it("claude gets no bypass flag unless elevated", () => {
    expect(permissionArgsFor("claude", "restricted")).toEqual([]);
    expect(permissionArgsFor("claude", "workspace_write")).toEqual([]);
    expect(permissionArgsFor("claude", "elevated")).toEqual(["--dangerously-skip-permissions"]);
  });

  it("codex sandboxes by default", () => {
    expect(permissionArgsFor("codex", "restricted")).toEqual(["--sandbox", "read-only"]);
    expect(permissionArgsFor("codex", "workspace_write")).toEqual(["--sandbox", "workspace-write"]);
    expect(permissionArgsFor("codex", "elevated")).toEqual(["--yolo"]);
  });

  it("gemini requires approval by default", () => {
    expect(permissionArgsFor("gemini", "restricted")).toEqual(["--approval-mode", "default"]);
    expect(permissionArgsFor("gemini", "elevated")).toEqual(["--approval-mode", "yolo"]);
  });
});

describe("adapters no longer hardcode bypass flags (regression for T-01)", () => {
  const ctx = { prompt: "hi", workdir: "/tmp/ws" };

  it("claude adapter default argv is safe", () => {
    const args = claudeAdapter.buildArgs(ctx);
    expect(containsDangerousFlag(args)).toBe(false);
    expect(args).not.toContain("--dangerously-skip-permissions");
    // the rest of the invocation is unchanged
    expect(args[0]).toBe("claude");
    expect(args).toContain("--output-format=stream-json");
  });

  it("codex adapter default argv is sandboxed", () => {
    const args = codexAdapter.buildArgs(ctx);
    expect(containsDangerousFlag(args)).toBe(false);
    expect(args).toContain("--sandbox");
    expect(args).toContain("read-only");
    expect(args).toContain("exec");
  });

  it("gemini adapter default argv is safe", () => {
    const args = geminiAdapter.buildArgs(ctx);
    expect(containsDangerousFlag(args)).toBe(false);
    expect(args).toContain("--output-format=stream-json");
  });

  it("elevated mode restores the flags for each adapter", () => {
    expect(claudeAdapter.buildArgs({ ...ctx, permissionMode: "elevated" })).toContain(
      "--dangerously-skip-permissions",
    );
    expect(codexAdapter.buildArgs({ ...ctx, permissionMode: "elevated" })).toContain("--yolo");
    expect(geminiAdapter.buildArgs({ ...ctx, permissionMode: "elevated" })).toContain("yolo");
  });
});

describe("spawn guard", () => {
  it("rejects hand-assembled argv carrying a bypass flag in restricted mode", () => {
    expect(() => assertArgsMatchMode(["claude", "--dangerously-skip-permissions"], "restricted")).toThrow(
      PermissionPolicyError,
    );
    expect(() => assertArgsMatchMode(["codex", "--yolo"], "workspace_write")).toThrow(
      PermissionPolicyError,
    );
    expect(() =>
      assertArgsMatchMode(["codex", "--dangerously-bypass-approvals-and-sandbox"], "restricted"),
    ).toThrow(PermissionPolicyError);
  });

  it("permits the flag when policy resolved to elevated", () => {
    expect(() =>
      assertArgsMatchMode(["claude", "--dangerously-skip-permissions"], "elevated"),
    ).not.toThrow();
  });

  it("permits ordinary argv", () => {
    expect(() => assertArgsMatchMode(["claude", "--print"], "restricted")).not.toThrow();
  });
});
