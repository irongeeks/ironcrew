import { describe, expect, it } from "vitest";
import path from "node:path";

// Reproducer for B-003 (issue #54): path traversal in /api/github/clone via
// unvalidated `repo` and `target_path` body parameters.
//
// The original code at server/modules/routes/core/github-routes.ts:225-232:
//   const defaultTarget = path.join(os.homedir(), "Projects", repo);
//   let targetPath = target_path?.trim() || defaultTarget;
// allowed `repo = "../../etc"` to resolve to a directory outside ~/Projects
// (or outside the home directory entirely), and an absolute `target_path`
// could write to ANY location the server process had access to (e.g. /etc,
// /var, another user's $HOME).
//
// The fix introduces a pure validator that:
//   - rejects owner/repo containing anything outside the GitHub naming class
//   - resolves the final clone path
//   - guarantees the result is contained within an allowed root (homedir)
import { resolveClonePath } from "../../../modules/routes/core/clone-path-validation.ts";

const HOME = "/home/testuser";

describe("resolveClonePath — owner/repo validation (B-003)", () => {
  const malicious: Array<[string, string, string]> = [
    ["dot-dot in repo", "octocat", "../../etc"],
    ["forward slash in repo", "octocat", "evil/../etc"],
    ["leading slash in repo", "octocat", "/etc"],
    ["dot-dot in owner", "../etc", "Hello-World"],
    ["null byte in repo", "octocat", "Hello World"],
    ["space in repo", "octocat", "Hello World"],
    ["empty repo", "octocat", ""],
    ["empty owner", "", "Hello-World"],
    ["repo only `.`", "octocat", "."],
    ["repo only `..`", "octocat", ".."],
  ];

  it.each(malicious)("rejects %s", (_label, owner, repo) => {
    expect(() => resolveClonePath({ owner, repo, homeRoot: HOME })).toThrow();
  });

  it("accepts a normal owner/repo", () => {
    const out = resolveClonePath({ owner: "octocat", repo: "Hello-World", homeRoot: HOME });
    expect(out).toBe(path.join(HOME, "Projects", "Hello-World"));
  });

  it("accepts owner/repo with allowed special chars (`.`, `_`, `-`)", () => {
    const out = resolveClonePath({ owner: "my-org", repo: "my.repo_v2", homeRoot: HOME });
    expect(out).toBe(path.join(HOME, "Projects", "my.repo_v2"));
  });

  it("rejects repo starting with a dot (hidden directory)", () => {
    expect(() => resolveClonePath({ owner: "octocat", repo: ".bashrc", homeRoot: HOME })).toThrow();
  });
});

describe("resolveClonePath — target_path validation (B-003)", () => {
  it("resolves `~` to homeRoot", () => {
    const out = resolveClonePath({ owner: "octocat", repo: "Hello-World", targetPath: "~", homeRoot: HOME });
    expect(out).toBe(HOME);
  });

  it("resolves `~/Code/foo` to homeRoot/Code/foo", () => {
    const out = resolveClonePath({
      owner: "octocat",
      repo: "Hello-World",
      targetPath: "~/Code/Hello-World",
      homeRoot: HOME,
    });
    expect(out).toBe(path.join(HOME, "Code", "Hello-World"));
  });

  it("rejects absolute path outside homeRoot", () => {
    expect(() =>
      resolveClonePath({ owner: "octocat", repo: "Hello-World", targetPath: "/etc/cron.d/evil", homeRoot: HOME }),
    ).toThrow(/outside.*home|invalid.*path/i);
  });

  it("rejects `~/../other-user/path` (escapes home via traversal)", () => {
    expect(() =>
      resolveClonePath({ owner: "octocat", repo: "Hello-World", targetPath: "~/../other-user", homeRoot: HOME }),
    ).toThrow();
  });

  it("rejects relative `../escape`", () => {
    expect(() =>
      resolveClonePath({ owner: "octocat", repo: "Hello-World", targetPath: "../escape", homeRoot: HOME }),
    ).toThrow();
  });

  it("trims whitespace before validation", () => {
    const out = resolveClonePath({
      owner: "octocat",
      repo: "Hello-World",
      targetPath: "  ~/Code/foo  ",
      homeRoot: HOME,
    });
    expect(out).toBe(path.join(HOME, "Code", "foo"));
  });

  it("falls back to default when targetPath is empty string after trim", () => {
    const out = resolveClonePath({ owner: "octocat", repo: "Hello-World", targetPath: "   ", homeRoot: HOME });
    expect(out).toBe(path.join(HOME, "Projects", "Hello-World"));
  });

  it("falls back to default when targetPath is undefined", () => {
    const out = resolveClonePath({ owner: "octocat", repo: "Hello-World", homeRoot: HOME });
    expect(out).toBe(path.join(HOME, "Projects", "Hello-World"));
  });

  it("rejects targetPath with null byte", () => {
    expect(() =>
      resolveClonePath({
        owner: "octocat",
        repo: "Hello-World",
        targetPath: "~/Code/foo .txt",
        homeRoot: HOME,
      }),
    ).toThrow();
  });
});

describe("resolveClonePath — error contract", () => {
  it("throws an Error with a useful message", () => {
    try {
      resolveClonePath({ owner: "octocat", repo: "../etc", homeRoot: HOME });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/repo|owner|invalid/i);
    }
  });

  it("rejects non-string owner / repo", () => {
    expect(() => resolveClonePath({ owner: 123 as unknown as string, repo: "Hello-World", homeRoot: HOME })).toThrow();
    expect(() => resolveClonePath({ owner: "octocat", repo: null as unknown as string, homeRoot: HOME })).toThrow();
  });
});
