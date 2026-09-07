import https from "node:https";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { TLSSocket } from "node:tls";
import { createHash } from "node:crypto";
import { z } from "zod";
import { scopeSchema } from "../../contracts/src/index.ts";
import { secretRefSchema, type SecretResolver } from "./secrets.ts";
import { IntegrationError, checkResponse, type HttpResponse } from "./transport.ts";
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const secureUrl = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password && !url.hash && !url.search;
});
export const hostingProfileSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    scope: scopeSchema,
    provider: z.literal("ironcrew-hosting-v1"),
    endpoint: secureUrl,
    secretRef: secretRefSchema.optional(),
    trustedCaPem: z.string().min(40).max(20000).optional(),
    publicUrl: secureUrl.refine((value) => new URL(value).pathname === "/"),
    expectedDnsAddresses: z
      .array(z.string().refine((value) => isIP(value) !== 0))
      .min(1)
      .max(16),
    stack: z.enum(["static", "react", "wordpress"]),
    plan: z.string().regex(/^[A-Za-z0-9._-]{1,80}$/),
    monthlyCostLimitUsdMicros: z.string().regex(/^\d+$/),
    healthContains: z.array(z.string().min(1).max(200)).min(1).max(10),
    timeoutMs: z.number().int().min(100).max(60000).default(30000),
  })
  .strict();
export type HostingProfileInput = z.infer<typeof hostingProfileSchema>;
export interface HostingProfile extends HostingProfileInput {
  id: string;
  fingerprint: string;
  configuredBy: string;
  configuredAt: string;
}
export interface HostingPackage {
  artifactVersionId: string;
  packageSha256: string;
  archiveSha256: string;
  archive: Buffer;
  entrySha256: string;
}
export interface HostingResource {
  id: string;
  publicUrl: string;
  stack: HostingProfile["stack"];
  monthlyCostUsdMicros: string;
  state: "ready";
}
export interface HostingDeployment {
  id: string;
  resourceId: string;
  publicUrl: string;
  artifactVersionId: string;
  packageSha256: string;
  archiveSha256: string;
  rollbackRef: string;
}
export interface HostingHealth {
  observedAt: string;
  dnsAddresses: string[];
  connectedAddress: string;
  tlsFingerprint256: string;
  tlsValidTo: string;
  httpsVerified: true;
  functionalCheckPassed: true;
  bodySha256: string;
  deploymentProofSha256: string;
  checks: string[];
}
export interface HostingPort {
  provision(profile: HostingProfile, actionId: string): Promise<HostingResource>;
  deploy(
    profile: HostingProfile,
    resourceId: string,
    actionId: string,
    artifact: HostingPackage,
  ): Promise<HostingDeployment>;
  verify(profile: HostingProfile, deployment: HostingDeployment, artifact: HostingPackage): Promise<HostingHealth>;
  rollback(
    profile: HostingProfile,
    resourceId: string,
    actionId: string,
    rollbackRef: string,
  ): Promise<{ rollbackRef: string; state: "accepted" }>;
}
type PeerResponse = HttpResponse & { connectedAddress: string; fingerprint256: string; validTo: string };
async function boundedLookup(hostname: string, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      lookup(hostname, { all: true, verbatim: true }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("dns_timeout")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function request(
  profile: HostingProfileInput,
  url: URL,
  method: string,
  body?: Buffer,
  token?: string,
  selected?: { address: string; family: number },
): Promise<PeerResponse> {
  if (url.protocol !== "https:") throw new IntegrationError("configuration", "Hosting benötigt HTTPS.");
  const writing = method !== "GET";
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (error?: IntegrationError, response?: PeerResponse) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(response!);
    };
    const req = https.request(
      url,
      {
        method,
        agent: false,
        rejectUnauthorized: true,
        ca: profile.trustedCaPem,
        headers: {
          accept: "application/json",
          ...(body ? { "content-type": "application/json", "content-length": String(body.length) } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        ...(selected
          ? {
              lookup: (_host, options, callback) => {
                if (typeof options === "object" && options.all) callback(null, [selected]);
                else callback(null, selected.address, selected.family);
              },
            }
          : {}),
      },
      (res) => {
        const socket = res.socket as TLSSocket,
          certificate = socket.getPeerCertificate();
        const peer = {
          connectedAddress: socket.remoteAddress ?? "",
          fingerprint256: certificate.fingerprint256 ?? "",
          validTo: certificate.valid_to ?? "",
        };
        if (!socket.authorized) {
          res.destroy();
          finish(
            new IntegrationError(
              "auth",
              "Hosting-TLS konnte nicht verifiziert werden.",
              writing ? "effect_unknown" : "failed",
            ),
          );
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 4 * 1024 * 1024) {
            res.destroy();
            finish(
              new IntegrationError(
                "response_limit",
                "Hostingantwort ist zu groß.",
                writing ? "effect_unknown" : "failed",
              ),
            );
          } else chunks.push(chunk);
        });
        res.on("error", () =>
          finish(
            new IntegrationError(
              "transport",
              "Hostingantwort wurde unterbrochen.",
              writing ? "effect_unknown" : "failed",
            ),
          ),
        );
        res.on("end", () => {
          const headers: Record<string, string> = {};
          for (const [key, value] of Object.entries(res.headers))
            if (value !== undefined) headers[key] = Array.isArray(value) ? value.join(",") : value;
          finish(undefined, { status: res.statusCode ?? 502, headers, body: Buffer.concat(chunks), ...peer });
        });
      },
    );
    const timer = setTimeout(() => {
      req.destroy();
      finish(
        new IntegrationError(
          "timeout",
          "Hostingoperation hat keine abschließende Antwort geliefert.",
          writing ? "effect_unknown" : "failed",
        ),
      );
    }, profile.timeoutMs);
    req.on("error", () =>
      finish(
        new IntegrationError("transport", "Hostingverbindung fehlgeschlagen.", writing ? "effect_unknown" : "failed"),
      ),
    );
    if (body) req.write(body);
    req.end();
  });
}
const resourceSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
    publicUrl: secureUrl,
    stack: z.enum(["static", "react", "wordpress"]),
    monthlyCostUsdMicros: z.string().regex(/^\d+$/),
    state: z.literal("ready"),
  })
  .strict();
const deploymentSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
    resourceId: z.string().min(1),
    publicUrl: secureUrl,
    artifactVersionId: z.uuid(),
    packageSha256: z.string().regex(/^[a-f0-9]{64}$/),
    archiveSha256: z.string().regex(/^[a-f0-9]{64}$/),
    rollbackRef: z.string().min(1).max(200),
  })
  .strict();
/** Versioned IronCrew broker protocol, not a claim of a native third-party hosting API. */
export class HostingHttpClient implements HostingPort {
  private readonly secrets?: SecretResolver;
  constructor(secrets?: SecretResolver) {
    this.secrets = secrets;
  }
  private async call(profile: HostingProfile, route: string, actionId: string, body: unknown) {
    const token = profile.secretRef
      ? await this.secrets?.resolve(profile.secretRef, `Authorized hosting action ${actionId}`)
      : undefined;
    if (profile.secretRef && !token)
      throw new IntegrationError("configuration", "Hostingzugang ist nicht eingerichtet.");
    const bytes = Buffer.from(JSON.stringify({ protocolVersion: 1, actionId, ...(body as object) }));
    if (bytes.length > 70 * 1024 * 1024) throw new IntegrationError("validation", "Hostingpaket überschreitet 50 MiB.");
    const response = await request(profile, new URL(profile.endpoint.replace(/\/$/, "") + route), "POST", bytes, token);
    checkResponse(response, true);
    if (response.status !== 200 && response.status !== 201)
      throw new IntegrationError("provider", "Hostingwirkung ist noch nicht abschließend bestätigt.", "effect_unknown");
    try {
      return JSON.parse(response.body.toString("utf8"));
    } catch {
      throw new IntegrationError("provider", "Hostingantwort ist ungültig.", "effect_unknown");
    }
  }
  async provision(profile: HostingProfile, actionId: string) {
    const raw = await this.call(profile, "/v1/resources", actionId, {
      targetId: profile.id,
      publicUrl: profile.publicUrl,
      stack: profile.stack,
      plan: profile.plan,
      monthlyCostLimitUsdMicros: profile.monthlyCostLimitUsdMicros,
    });
    const parsed = resourceSchema.safeParse(raw);
    if (
      !parsed.success ||
      parsed.data.publicUrl !== profile.publicUrl ||
      parsed.data.stack !== profile.stack ||
      BigInt(parsed.data.monthlyCostUsdMicros) > BigInt(profile.monthlyCostLimitUsdMicros)
    )
      throw new IntegrationError(
        "provider",
        "Provisionierung entspricht nicht dem freigegebenen Ziel/Kostenrahmen.",
        "effect_unknown",
      );
    return parsed.data;
  }
  async deploy(profile: HostingProfile, resourceId: string, actionId: string, artifact: HostingPackage) {
    if (artifact.archive.length > 50 * 1024 * 1024 || hash(artifact.archive) !== artifact.archiveSha256)
      throw new IntegrationError("validation", "Veröffentlichungspaket ist ungültig.");
    const raw = await this.call(profile, `/v1/resources/${encodeURIComponent(resourceId)}/deployments`, actionId, {
      targetId: profile.id,
      publicUrl: profile.publicUrl,
      artifactVersionId: artifact.artifactVersionId,
      packageSha256: artifact.packageSha256,
      archiveSha256: artifact.archiveSha256,
      archiveBase64: artifact.archive.toString("base64"),
    });
    const parsed = deploymentSchema.safeParse(raw);
    if (
      !parsed.success ||
      parsed.data.resourceId !== resourceId ||
      parsed.data.publicUrl !== profile.publicUrl ||
      parsed.data.artifactVersionId !== artifact.artifactVersionId ||
      parsed.data.packageSha256 !== artifact.packageSha256 ||
      parsed.data.archiveSha256 !== artifact.archiveSha256
    )
      throw new IntegrationError(
        "provider",
        "Deploymentantwort ist nicht an das freigegebene Paket gebunden.",
        "effect_unknown",
      );
    return parsed.data;
  }
  async verify(
    profile: HostingProfile,
    deployment: HostingDeployment,
    artifact: HostingPackage,
  ): Promise<HostingHealth> {
    try {
      if (
        deployment.publicUrl !== profile.publicUrl ||
        deployment.artifactVersionId !== artifact.artifactVersionId ||
        deployment.packageSha256 !== artifact.packageSha256 ||
        deployment.archiveSha256 !== artifact.archiveSha256
      )
        throw new Error("deployment_binding");
      const url = new URL(profile.publicUrl),
        addresses = await boundedLookup(url.hostname, profile.timeoutMs);
      if (!addresses.length || addresses.some((item) => !profile.expectedDnsAddresses.includes(item.address)))
        throw new Error("dns");
      const selected = addresses[0],
        page = await request(profile, url, "GET", undefined, undefined, selected);
      checkResponse(page, false);
      if (
        page.status !== 200 ||
        !page.headers["content-type"]?.includes("text/html") ||
        profile.healthContains.some((text) => !page.body.toString("utf8").includes(text))
      )
        throw new Error("functional");
      if (profile.stack !== "wordpress" && hash(page.body) !== artifact.entrySha256) throw new Error("content_version");
      const proof = await request(
        profile,
        new URL("/.well-known/ironcrew-deployment.json", url),
        "GET",
        undefined,
        undefined,
        selected,
      );
      checkResponse(proof, false);
      if (proof.status !== 200) throw new Error("proof_status");
      const parsed = z
        .object({
          artifactVersionId: z.literal(artifact.artifactVersionId),
          packageSha256: z.literal(artifact.packageSha256),
          archiveSha256: z.literal(artifact.archiveSha256),
        })
        .parse(JSON.parse(proof.body.toString("utf8")));
      if (!parsed || !page.fingerprint256 || !page.validTo) throw new Error("tls");
      return {
        observedAt: new Date().toISOString(),
        dnsAddresses: addresses.map((item) => item.address),
        connectedAddress: page.connectedAddress,
        tlsFingerprint256: page.fingerprint256,
        tlsValidTo: page.validTo,
        httpsVerified: true,
        functionalCheckPassed: true,
        bodySha256: hash(page.body),
        deploymentProofSha256: hash(proof.body),
        checks: [
          "dns_expected_addresses",
          "tls_chain_and_hostname",
          "http_200_html",
          "configured_content_assertions",
          "deployment_identity",
          ...(profile.stack !== "wordpress" ? ["artifact_entry_sha256"] : []),
        ],
      };
    } catch {
      throw new IntegrationError(
        "provider",
        "Veröffentlichung wurde ausgeführt, aber DNS/TLS/Funktion/Version ist nicht bestätigt.",
        "effect_unknown",
      );
    }
  }
  async rollback(profile: HostingProfile, resourceId: string, actionId: string, rollbackRef: string) {
    const raw = await this.call(profile, `/v1/resources/${encodeURIComponent(resourceId)}/rollback`, actionId, {
      rollbackRef,
      targetId: profile.id,
    });
    const parsed = z.object({ rollbackRef: z.literal(rollbackRef), state: z.literal("accepted") }).safeParse(raw);
    if (!parsed.success) throw new IntegrationError("provider", "Rückweg ist nicht bestätigt.", "effect_unknown");
    return parsed.data;
  }
}
/** Shared bounded, certificate-verifying transport for the separately authorized hosting-care protocol. */
export { request as hostingPeerRequest, boundedLookup as hostingLookup };
