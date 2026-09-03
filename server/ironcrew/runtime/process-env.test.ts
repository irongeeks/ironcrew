import { describe, it, expect } from "vitest";
import { buildCliSpawnEnv, cliPathFallbackDirs, withCliPathFallback } from "./process-env.ts";

describe("cliPathFallbackDirs", () => {
  it("includes the common install locations under the given home dir", () => {
    const dirs = cliPathFallbackDirs("/home/robert");
    expect(dirs).toContain("/usr/local/bin");
    expect(dirs).toContain("/home/robert/.local/bin");
    expect(dirs).toContain("/home/robert/bin");
  });
});

describe("withCliPathFallback", () => {
  it("appends fallback dirs not already present, preserving order", () => {
    const out = withCliPathFallback("/usr/bin:/bin", ["/opt/x", "/usr/bin"]);
    expect(out.split(":")).toEqual(["/usr/bin", "/bin", "/opt/x"]);
  });

  it("handles an empty or undefined starting PATH", () => {
    expect(withCliPathFallback(undefined, ["/opt/x"]).split(":")).toEqual(["/opt/x"]);
    expect(withCliPathFallback("", ["/opt/x"]).split(":")).toEqual(["/opt/x"]);
  });

  it("de-duplicates and trims whitespace in the source PATH", () => {
    const out = withCliPathFallback(" /usr/bin : /usr/bin ", ["/usr/bin", "/opt/y"]);
    expect(out.split(":")).toEqual(["/usr/bin", "/opt/y"]);
  });
});

describe("buildCliSpawnEnv", () => {
  it("strips CLAUDECODE and CLAUDE_CODE so a nested session is not detected", () => {
    const env = buildCliSpawnEnv({ CLAUDECODE: "1", CLAUDE_CODE: "1", PATH: "/usr/bin" });
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE).toBeUndefined();
  });

  it("forces non-interactive, non-colour output", () => {
    const env = buildCliSpawnEnv({ PATH: "/usr/bin" });
    expect(env.NO_COLOR).toBe("1");
    expect(env.FORCE_COLOR).toBe("0");
    expect(env.CI).toBe("1");
  });

  it("supplies a default TERM only when absent", () => {
    expect(buildCliSpawnEnv({ PATH: "/usr/bin" }).TERM).toBe("dumb");
    expect(buildCliSpawnEnv({ PATH: "/usr/bin", TERM: "xterm-256color" }).TERM).toBe("xterm-256color");
  });

  it("extends PATH with fallback dirs", () => {
    const env = buildCliSpawnEnv({ PATH: "/usr/bin" }, { homeDir: "/home/robert" });
    expect(env.PATH).toContain("/usr/bin");
    expect(env.PATH).toContain("/home/robert/.local/bin");
  });

  it("drops undefined-valued entries rather than passing them through", () => {
    const env = buildCliSpawnEnv({ PATH: "/usr/bin", SOME_VAR: undefined });
    expect("SOME_VAR" in env).toBe(false);
  });

  it("preserves ordinary environment variables untouched", () => {
    const env = buildCliSpawnEnv({ PATH: "/usr/bin", HOME: "/home/robert", LANG: "de_DE.UTF-8" });
    expect(env.HOME).toBe("/home/robert");
    expect(env.LANG).toBe("de_DE.UTF-8");
  });
});
