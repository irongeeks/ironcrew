import { describe, it, expect } from "vitest";
import { TailscaleProvider, TailscaleError } from "./tailscale-provider.ts";
import type { CliRunner, CliRunResult } from "../shared/cli-runner.ts";

function fakeRunner(byArgv: (argv: readonly string[]) => CliRunResult): CliRunner {
  return async (argv) => byArgv(argv);
}

const ok = (stdout = "", stderr = ""): CliRunResult => ({ stdout, stderr, code: 0 });
const fail = (stderr = "boom"): CliRunResult => ({ stdout: "", stderr, code: 1 });

const RUNNING_STATUS = {
  BackendState: "Running",
  Self: {
    ID: "1",
    HostName: "crew-server",
    DNSName: "crew-server.tailnet.ts.net.",
    TailscaleIPs: ["100.1.1.1"],
    Online: true,
  },
  Peer: {
    "nodekey:a": {
      ID: "2",
      HostName: "tier0-worker",
      DNSName: "tier0-worker.tailnet.ts.net.",
      TailscaleIPs: ["100.1.1.2"],
      Online: true,
      OS: "linux",
    },
  },
};

describe("TailscaleProvider.status", () => {
  it("parses backend state, self and peers from tailscale status --json", async () => {
    const calls: string[][] = [];
    const provider = new TailscaleProvider({
      run: fakeRunner((argv) => {
        calls.push([...argv]);
        return ok(JSON.stringify(RUNNING_STATUS));
      }),
    });
    const status = await provider.status();
    expect(calls[0]).toEqual(["tailscale", "status", "--json"]);
    expect(status.backendState).toBe("Running");
    expect(status.self).toEqual({
      id: "1",
      hostName: "crew-server",
      dnsName: "crew-server.tailnet.ts.net.",
      tailscaleIPs: ["100.1.1.1"],
      online: true,
      os: "",
    });
    expect(status.peers).toEqual([
      {
        id: "2",
        hostName: "tier0-worker",
        dnsName: "tier0-worker.tailnet.ts.net.",
        tailscaleIPs: ["100.1.1.2"],
        online: true,
        os: "linux",
      },
    ]);
  });

  it("throws TailscaleError when the CLI exits non-zero", async () => {
    const provider = new TailscaleProvider({ run: fakeRunner(() => fail("not logged in")) });
    await expect(provider.status()).rejects.toBeInstanceOf(TailscaleError);
  });

  it("throws TailscaleError when the output is not valid JSON", async () => {
    const provider = new TailscaleProvider({ run: fakeRunner(() => ok("not json")) });
    await expect(provider.status()).rejects.toThrow(/could not parse/);
  });

  it("handles an empty Peer map", async () => {
    const provider = new TailscaleProvider({
      run: fakeRunner(() => ok(JSON.stringify({ BackendState: "Running", Self: RUNNING_STATUS.Self }))),
    });
    const status = await provider.status();
    expect(status.peers).toEqual([]);
  });
});

describe("TailscaleProvider.testConnection", () => {
  it("reports ok with self hostname + IP when the backend is running", async () => {
    const provider = new TailscaleProvider({ run: fakeRunner(() => ok(JSON.stringify(RUNNING_STATUS))) });
    const result = await provider.testConnection();
    expect(result).toEqual({ ok: true, message: "verbunden als crew-server (100.1.1.1)" });
  });

  it("reports not-ok when the backend needs login", async () => {
    const provider = new TailscaleProvider({
      run: fakeRunner(() => ok(JSON.stringify({ BackendState: "NeedsLogin", Peer: {} }))),
    });
    const result = await provider.testConnection();
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/NeedsLogin/);
  });

  it("reports not-ok when tailscale is not installed", async () => {
    const provider = new TailscaleProvider({
      run: fakeRunner(() => {
        throw new Error("spawn tailscale ENOENT");
      }),
    });
    const result = await provider.testConnection();
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/ENOENT/);
  });
});
