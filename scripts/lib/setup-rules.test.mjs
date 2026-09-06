import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { injectAgentsRules } from "../setup.mjs";
const directories = [];
afterEach(() => {
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
describe("installer orchestration rules", () => {
  it("keeps an installed rules file byte-identical across repeated setup", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ironcrew-setup-test-"));
    directories.push(dir);
    const agentsPath = path.join(dir, "AGENTS.md");
    fs.copyFileSync("AGENTS.md", agentsPath);
    const before = fs.readFileSync(agentsPath, "utf8");
    injectAgentsRules({ agentsPath, port: "8790" });
    expect(fs.readFileSync(agentsPath, "utf8")).toBe(before);
    injectAgentsRules({ agentsPath, port: "8790" });
    expect(fs.readFileSync(agentsPath, "utf8")).toBe(before);
  });
  it("preserves user content on a new installation and subsequent update", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ironcrew-setup-test-"));
    directories.push(dir);
    const agentsPath = path.join(dir, "AGENTS.md");
    fs.writeFileSync(agentsPath, "# My rules\nKeep these.\n");
    injectAgentsRules({ agentsPath, port: "1234" });
    const installed = fs.readFileSync(agentsPath, "utf8");
    expect(installed).toContain("# My rules\nKeep these.\n");
    injectAgentsRules({ agentsPath, port: "1234" });
    expect(fs.readFileSync(agentsPath, "utf8")).toBe(installed);
  });
});
