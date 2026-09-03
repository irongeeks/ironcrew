export type AutoUpdateChannel = "patch" | "minor" | "all";
export type UpdateDeltaKind = "none" | "patch" | "minor" | "major";

export function normalizeVersionTag(value: string): string {
  return String(value ?? "")
    .trim()
    .replace(/^v/i, "");
}

/**
 * Keep only semver core (major.minor.patch), ignoring pre-release/build metadata.
 * Examples:
 * - 1.2.3-beta.1 -> 1.2.3
 * - 1.2.3+build.5 -> 1.2.3
 */
export function normalizeSemverCore(value: string): string {
  const normalized = normalizeVersionTag(value);
  if (!normalized) return "";
  const [withoutBuild] = normalized.split("+", 1);
  const [core] = withoutBuild.split("-", 1);
  const semverCore = core || normalized;
  if (!/^\d+\.\d+\.\d+$/.test(semverCore)) return "";
  return semverCore;
}

function parseSemverCoreParts(core: string): number[] {
  if (!core) return [0];
  return core.split(".").map((part) => {
    const matched = String(part).match(/\d+/);
    return matched ? Number(matched[0]) : 0;
  });
}

export function parseVersionParts(value: string): number[] {
  const normalized = normalizeSemverCore(value);
  return parseSemverCoreParts(normalized);
}

export function isRemoteVersionNewer(remote: string, local: string): boolean {
  const remoteCore = normalizeSemverCore(remote);
  const localCore = normalizeSemverCore(local);
  if (!remoteCore || !localCore) return false;

  const remoteParts = parseSemverCoreParts(remoteCore);
  const localParts = parseSemverCoreParts(localCore);
  const length = Math.max(remoteParts.length, localParts.length);
  for (let i = 0; i < length; i += 1) {
    const r = remoteParts[i] ?? 0;
    const l = localParts[i] ?? 0;
    if (r === l) continue;
    return r > l;
  }
  return false;
}

export function computeVersionDeltaKind(local: string, remote: string | null): UpdateDeltaKind {
  if (!remote || !isRemoteVersionNewer(remote, local)) return "none";
  const l = parseVersionParts(local);
  const r = parseVersionParts(remote);
  const [lMajor = 0, lMinor = 0] = l;
  const [rMajor = 0, rMinor = 0] = r;
  if (rMajor > lMajor) return "major";
  if (rMinor > lMinor) return "minor";
  return "patch";
}

export function isDeltaAllowedByChannel(delta: UpdateDeltaKind, channel: AutoUpdateChannel): boolean {
  if (delta === "none") return false;
  if (channel === "all") return true;
  if (channel === "minor") return delta === "minor" || delta === "patch";
  return delta === "patch";
}
