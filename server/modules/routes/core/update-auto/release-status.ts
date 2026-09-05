import fs from "node:fs";
import path from "node:path";
import { isRemoteVersionNewer } from "../../update-auto-utils.ts";
import { releaseVersionOrderOverride } from "../../../../../scripts/lib/release-version.mjs";

export const RELEASE_REPOSITORY = "irongeeks/ironcrew";
export const RELEASES_URL = `https://github.com/${RELEASE_REPOSITORY}/releases`;
export const UPDATE_DOCUMENTATION_URL = `https://github.com/${RELEASE_REPOSITORY}/blob/main/docs/RELEASES.md`;
export type InstallType = "docker" | "native" | "source";
export interface ReleaseUpdateStatus {
  current_version: string;
  latest_version: string | null;
  latest_tag: string | null;
  update_available: boolean;
  release_url: string | null;
  checked_at: number;
  enabled: boolean;
  repo: string;
  error: string | null;
  channel: "stable";
  install_type: InstallType;
  discovery: "available" | "up_to_date" | "no_release" | "disabled" | "unavailable";
  self_update_supported: false;
  instructions: { command: string | null; steps: string[]; documentation_url: string };
}
export function detectInstallType(env = process.env, cwd = process.cwd()): InstallType {
  if (
    env.IRONCREW_INSTALL_TYPE === "docker" ||
    env.IRONCREW_INSTALL_TYPE === "native" ||
    env.IRONCREW_INSTALL_TYPE === "source"
  )
    return env.IRONCREW_INSTALL_TYPE;
  if (fs.existsSync("/.dockerenv") || env.DOCKER_CONTAINER || env.CONTAINER === "docker") return "docker";
  return fs.existsSync(path.join(cwd, ".git")) ? "source" : "native";
}
export function releaseInstructions(type: InstallType, tag: string | null): ReleaseUpdateStatus["instructions"] {
  const validTag = tag && /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(tag) ? tag : null;
  const script = type === "docker" ? "ironcrew-docker-update.mjs" : "ironcrew-update.mjs";
  return {
    command: validTag
      ? `node scripts/${script} --to ${validTag}${type === "docker" ? " --backup-dir /ABS/backups" : ""} --check`
      : null,
    steps: [
      "Release-Hinweise prüfen und aktuelle Sicherung samt Wiederherstellungsmöglichkeit vorbereiten.",
      type === "docker"
        ? "Den Update-Assistenten auf dem Docker-Host im IronCrew-Verzeichnis starten."
        : "Den Update-Assistenten auf dem Host im IronCrew-Verzeichnis starten.",
      type === "docker"
        ? "Im Prüfbefehl /ABS/backups durch einen privaten absoluten Backup-Pfad ersetzen. Nach erfolgreicher Vorprüfung denselben Befehl ohne --check ausführen; der Assistent übernimmt Sicherung und Neustart."
        : "Nach erfolgreicher Vorprüfung den Dienst stoppen und den Assistenten ohne --check mit --db /ABS/ironcrew.sqlite und --backup-dir /ABS/backups ausführen; Pfade anpassen und den Dienst anschließend starten. Details stehen in der Release-Anleitung.",
      "Nach der Aktualisierung Version, Systemzustand und laufende Aufgaben prüfen.",
    ],
    documentation_url: UPDATE_DOCUMENTATION_URL,
  };
}
export function createReleaseStatusReader(options: {
  currentVersion: string;
  installType: InstallType;
  enabled: boolean;
  ttlMs?: number;
  timeoutMs?: number;
  fetcher?: typeof fetch;
  now?: () => number;
}): (force?: boolean) => Promise<ReleaseUpdateStatus> {
  let cached: ReleaseUpdateStatus | null = null;
  let inFlight: Promise<ReleaseUpdateStatus> | null = null;
  const now = options.now ?? Date.now;
  return async (force = false) => {
    if (inFlight) return inFlight;
    if (!force && cached && now() - cached.checked_at < (options.ttlMs ?? 1_800_000)) return cached;
    inFlight = (async () => {
      let tag: string | null = null;
      let error: string | null = null;
      let discovery: ReleaseUpdateStatus["discovery"] = options.enabled ? "no_release" : "disabled";
      if (options.enabled) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 4000);
        try {
          const response = await (options.fetcher ?? fetch)(
            `https://api.github.com/repos/${RELEASE_REPOSITORY}/releases/latest`,
            {
              headers: { accept: "application/vnd.github+json", "user-agent": "ironcrew-release-check" },
              signal: controller.signal,
              redirect: "error",
            },
          );
          if (response.status !== 404) {
            if (!response.ok) throw new Error(`github_http_${response.status}`);
            const body = (await response.json()) as Record<string, unknown>;
            if (
              body.draft !== false ||
              body.prerelease !== false ||
              typeof body.tag_name !== "string" ||
              !/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(body.tag_name)
            )
              throw new Error("invalid_stable_release");
            tag = body.tag_name;
            const override = releaseVersionOrderOverride(tag, options.currentVersion);
            discovery = (override === null ? isRemoteVersionNewer(tag, options.currentVersion) : override > 0)
              ? "available"
              : "up_to_date";
          }
        } catch (cause) {
          discovery = "unavailable";
          error =
            cause instanceof Error && /^github_http_\d+$|^invalid_stable_release$/.test(cause.message)
              ? cause.message
              : "release_check_unavailable";
        } finally {
          clearTimeout(timer);
        }
      }
      cached = {
        current_version: options.currentVersion,
        latest_version: tag?.slice(1) ?? null,
        latest_tag: tag,
        update_available: discovery === "available",
        release_url: tag ? `${RELEASES_URL}/tag/${tag}` : null,
        checked_at: now(),
        enabled: options.enabled,
        repo: RELEASE_REPOSITORY,
        error,
        channel: "stable",
        install_type: options.installType,
        discovery,
        self_update_supported: false,
        instructions: releaseInstructions(options.installType, discovery === "available" ? tag : null),
      };
      return cached;
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}
