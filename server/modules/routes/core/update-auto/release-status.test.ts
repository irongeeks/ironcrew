import { describe, expect, it, vi } from "vitest";
import { createReleaseStatusReader, releaseInstructions } from "./release-status.ts";
const release = { tag_name: "v2.1.0", draft: false, prerelease: false, html_url: "https://untrusted.invalid/run" };
const reader = (fetcher: typeof fetch) =>
  createReleaseStatusReader({ currentVersion: "2.0.0", installType: "native", enabled: true, fetcher });
describe("stable IronCrew release discovery", () => {
  it("uses only the official stable release and constructs its own safe release URL", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(release)));
    const read = reader(fetcher);
    const status = await read();
    expect(fetcher.mock.calls[0][0]).toBe("https://api.github.com/repos/irongeeks/ironcrew/releases/latest");
    expect(status).toMatchObject({
      latest_version: "2.1.0",
      latest_tag: "v2.1.0",
      channel: "stable",
      update_available: true,
      self_update_supported: false,
      release_url: "https://github.com/irongeeks/ironcrew/releases/tag/v2.1.0",
    });
    expect(status.instructions.command).toBe("node scripts/ironcrew-update.mjs --to v2.1.0 --check");
    await read();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    { draft: true },
    { prerelease: true },
    { tag_name: "main" },
    { tag_name: "v2.1.0-rc.1" },
    { tag_name: "v2.1.0;command" },
  ])("rejects draft, prerelease and non-release targets %j", async (override) => {
    const status = await reader(vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...release, ...override }))))();
    expect(status).toMatchObject({
      latest_tag: null,
      update_available: false,
      discovery: "unavailable",
      error: "invalid_stable_release",
    });
    expect(status.instructions.command).toBeNull();
  });
  it("distinguishes no published release, offline status and disabled checks", async () => {
    expect(await reader(vi.fn().mockResolvedValue(new Response("", { status: 404 })))()).toMatchObject({
      discovery: "no_release",
      error: null,
    });
    expect(await reader(vi.fn().mockRejectedValue(new Error("private diagnostic")))()).toMatchObject({
      discovery: "unavailable",
      error: "release_check_unavailable",
    });
    const fetcher = vi.fn();
    const read = createReleaseStatusReader({ currentVersion: "2.0.0", installType: "docker", enabled: false, fetcher });
    expect(await read()).toMatchObject({ discovery: "disabled", enabled: false, latest_tag: null });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("deduplicates simultaneous refreshes and only offers safe target-pinned host checks", async () => {
    let complete!: (r: Response) => void;
    const fetcher = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          complete = resolve;
        }),
    );
    const read = reader(fetcher);
    const first = read(true),
      second = read(true);
    complete(new Response(JSON.stringify(release)));
    await Promise.all([first, second]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(releaseInstructions("docker", "v2.1.0").command).toBe(
      "node scripts/ironcrew-docker-update.mjs --to v2.1.0 --backup-dir /ABS/backups --check",
    );
    expect(releaseInstructions("source", "main").command).toBeNull();
  });
});
