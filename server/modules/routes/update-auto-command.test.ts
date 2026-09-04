import { describe, expect, it } from "vitest";
import { parseSafeRestartCommand } from "./update-auto-command.ts";

describe("parseSafeRestartCommand", () => {
  it("parses safe commands", () => {
    expect(parseSafeRestartCommand("pm2 restart ironcrew")).toEqual({
      cmd: "pm2",
      args: ["restart", "ironcrew"],
    });
    expect(parseSafeRestartCommand('"/usr/local/bin/openclaw" gateway restart')).toEqual({
      cmd: "/usr/local/bin/openclaw",
      args: ["gateway", "restart"],
    });
    expect(parseSafeRestartCommand('openclaw "some\\"arg" plain')).toEqual({
      cmd: "openclaw",
      args: ['some"arg', "plain"],
    });
  });

  it("rejects shell and interpreter launchers", () => {
    expect(parseSafeRestartCommand('sh -c "echo hi"')).toBeNull();
    expect(parseSafeRestartCommand("/bin/bash -c 'echo hi'")).toBeNull();
    expect(parseSafeRestartCommand("cmd /c dir")).toBeNull();
    expect(parseSafeRestartCommand('powershell -Command "Get-Process"')).toBeNull();
    expect(parseSafeRestartCommand('pwsh -Command "Get-Process"')).toBeNull();
  });

  it("rejects shell meta characters", () => {
    expect(parseSafeRestartCommand("pm2 restart claw; rm -rf /")).toBeNull();
    expect(parseSafeRestartCommand("echo $HOME")).toBeNull();
    expect(parseSafeRestartCommand("a | b")).toBeNull();
  });

  it("rejects empty input", () => {
    expect(parseSafeRestartCommand("")).toBeNull();
    expect(parseSafeRestartCommand("   ")).toBeNull();
  });
});
