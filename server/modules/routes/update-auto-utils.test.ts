import { describe, expect, it } from "vitest";
import {
  computeVersionDeltaKind,
  isDeltaAllowedByChannel,
  isRemoteVersionNewer,
  normalizeSemverCore,
  parseVersionParts,
} from "./update-auto-utils.ts";

describe("update auto utils", () => {
  it("normalizes semver core", () => {
    expect(normalizeSemverCore("v1.2.3-beta.1+build.5")).toBe("1.2.3");
    expect(normalizeSemverCore("1.2.3+build.7")).toBe("1.2.3");
    expect(normalizeSemverCore("1.2.3")).toBe("1.2.3");
    expect(normalizeSemverCore("1.2.3-beta.1")).toBe("1.2.3");

    expect(normalizeSemverCore("")).toBe("");
    expect(normalizeSemverCore("invalid")).toBe("");
    expect(normalizeSemverCore("1")).toBe("");
    expect(normalizeSemverCore("1.2.x")).toBe("");
  });

  it("parses version parts safely", () => {
    expect(parseVersionParts("1.2.3")).toEqual([1, 2, 3]);
    expect(parseVersionParts("1.2.3-beta.1")).toEqual([1, 2, 3]);
    expect(parseVersionParts("invalid")).toEqual([0]);
  });

  it("detects newer version correctly", () => {
    expect(isRemoteVersionNewer("1.1.3", "1.1.2")).toBe(true);
    expect(isRemoteVersionNewer("1.2.0", "1.1.9")).toBe(true);
    expect(isRemoteVersionNewer("1.0.0", "1.0.0")).toBe(false);

    // versions with different part counts are normalized by strict semver rule
    expect(isRemoteVersionNewer("1.2", "1.2.0")).toBe(false);
    expect(isRemoteVersionNewer("1.2.0", "1.2")).toBe(false);

    expect(isRemoteVersionNewer("", "1.0.0")).toBe(false);
    expect(isRemoteVersionNewer("1.0.0", "")).toBe(false);
    expect(isRemoteVersionNewer("   ", "1.0.0")).toBe(false);
    expect(isRemoteVersionNewer("1.0.0", "   ")).toBe(false);
    expect(isRemoteVersionNewer(null as unknown as string, "1.0.0")).toBe(false);
    expect(isRemoteVersionNewer("1.0.0", null as unknown as string)).toBe(false);
    expect(isRemoteVersionNewer(undefined as unknown as string, "1.0.0")).toBe(false);
    expect(isRemoteVersionNewer("1.0.0", undefined as unknown as string)).toBe(false);

    expect(isRemoteVersionNewer("1.2.3-alpha", "1.2.3-beta")).toBe(false);
    expect(isRemoteVersionNewer("1.2.3-beta", "1.2.3-alpha")).toBe(false);

    // Pre-release tags are normalized away intentionally (strict semver ordering is not applied here).
    expect(isRemoteVersionNewer("1.2.3", "1.2.3-beta")).toBe(false);
    expect(isRemoteVersionNewer("1.2.3-beta", "1.2.3")).toBe(false);
  });

  it("classifies update delta kind", () => {
    expect(computeVersionDeltaKind("1.1.2", "1.1.3")).toBe("patch");
    expect(computeVersionDeltaKind("1.1.2", "1.2.0")).toBe("minor");
    expect(computeVersionDeltaKind("1.1.2", "2.0.0")).toBe("major");
    expect(computeVersionDeltaKind("1.1.2", "1.1.2")).toBe("none");
    expect(computeVersionDeltaKind("1.1.2", "")).toBe("none");
    expect(computeVersionDeltaKind("1.1.2", null)).toBe("none");
  });

  it("applies channel filtering", () => {
    expect(isDeltaAllowedByChannel("none", "patch")).toBe(false);
    expect(isDeltaAllowedByChannel("none", "minor")).toBe(false);
    expect(isDeltaAllowedByChannel("none", "all")).toBe(false);

    expect(isDeltaAllowedByChannel("patch", "patch")).toBe(true);
    expect(isDeltaAllowedByChannel("patch", "minor")).toBe(true);
    expect(isDeltaAllowedByChannel("patch", "all")).toBe(true);

    expect(isDeltaAllowedByChannel("minor", "patch")).toBe(false);
    expect(isDeltaAllowedByChannel("minor", "minor")).toBe(true);
    expect(isDeltaAllowedByChannel("minor", "all")).toBe(true);

    expect(isDeltaAllowedByChannel("major", "patch")).toBe(false);
    expect(isDeltaAllowedByChannel("major", "minor")).toBe(false);
    expect(isDeltaAllowedByChannel("major", "all")).toBe(true);
  });
});
