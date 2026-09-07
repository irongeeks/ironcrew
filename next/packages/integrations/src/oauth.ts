import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import https from "node:https";
import path from "node:path";
import { z } from "zod";
import { secretRefSchema, type SecretResolver } from "./secrets.ts";
import type { IntegrationScope } from "./service.ts";
import { IntegrationError } from "./transport.ts";

const token = z
  .string()
  .min(1)
  .max(32768)
  .refine((v) => !/[\r\n\0]/.test(v));
export const oauthConfigurationSchema = z
  .object({
    id: z.uuid(),
    authorizedGeneration: z.string().min(1).max(200).nullable().default(null),
    tokenEndpoint: z.url().refine((v) => {
      const u = new URL(v);
      return u.protocol === "https:" && !u.username && !u.password && !u.hash && !u.search;
    }),
    clientId: z.string().min(1).max(1000),
    clientAuthentication: z.enum(["client_secret_post", "client_secret_basic", "none"]),
    clientSecretRef: secretRefSchema.optional(),
    refreshTokenRef: secretRefSchema,
    encryptionKeyRef: secretRefSchema,
    scopes: z
      .array(
        z
          .string()
          .min(1)
          .max(500)
          .regex(/^[\x21\x23-\x5b\x5d-\x7e]+$/),
      )
      .min(1)
      .max(100),
    tlsCaFile: z.string().refine(path.isAbsolute).optional(),
    timeoutMs: z.number().int().min(100).max(60000).default(15000),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.clientAuthentication !== "none" && !c.clientSecretRef)
      ctx.addIssue({ code: "custom", message: "Client-Secret-Referenz fehlt." });
    if (new Set(c.scopes).size !== c.scopes.length)
      ctx.addIssue({ code: "custom", message: "Scopes müssen eindeutig sein." });
  });
export type OAuthConfiguration = z.input<typeof oauthConfigurationSchema>;
export interface OAuthContext {
  scope: IntegrationScope;
  connectionId: string;
  generation: string | null;
  reason: string;
  authorize(): Promise<void>;
}
const stateSchema = z
  .object({
    version: z.literal(1),
    binding: z.string(),
    status: z.enum(["ready", "refreshing", "reauthorization_required"]),
    accessToken: token.optional(),
    refreshToken: token,
    expiresAt: z.number().finite().optional(),
    scopes: z.array(z.string()),
    generation: z.number().int().nonnegative(),
  })
  .strict();
type State = z.infer<typeof stateSchema>;
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const canonical = (value: unknown): string => {
  const sort = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sort)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .filter(([, child]) => child !== undefined)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, child]) => [k, sort(child)]),
          )
        : v;
  return JSON.stringify(sort(value));
};
const failure = (unknown = false) =>
  new IntegrationError(
    "auth",
    unknown
      ? "OAuth-Erneuerung ist unklar. Zugang beim Provider neu autorisieren; keine automatische Wiederholung."
      : "OAuth-Zugang kann nicht erneuert werden. Konfiguration und Providerautorisierung prüfen.",
  );
async function readRegular(file: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = await handle.stat();
    if (!s.isFile() || s.nlink !== 1 || s.size > maxBytes) throw failure();
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}
/** Broker-local encrypted token rotation. Tokens never belong in application documents or model output. */
export class OAuthTokenBroker {
  private readonly options: { directory: string; secrets: SecretResolver; now?: () => number };
  private readonly flights = new Map<string, Promise<string>>();
  constructor(options: { directory: string; secrets: SecretResolver; now?: () => number }) {
    if (!path.isAbsolute(options.directory))
      throw new IntegrationError("configuration", "OAuth-Vault benötigt einen absoluten administrativen Pfad.");
    this.options = options;
  }
  async accessToken(input: OAuthConfiguration, context: OAuthContext): Promise<string> {
    const config = oauthConfigurationSchema.parse(input);
    await context.authorize();
    if (context.generation !== config.authorizedGeneration) throw failure();
    const binding = hash(canonical({ config, scope: context.scope, generation: context.generation }));
    let flight = this.flights.get(binding);
    if (!flight) {
      flight = this.resolve(config, context, binding);
      this.flights.set(binding, flight);
      void flight
        .finally(() => {
          if (this.flights.get(binding) === flight) this.flights.delete(binding);
        })
        .catch(() => {});
    }
    const result = await flight;
    // A concurrent caller has its own authority, independently of the refresh owner.
    await context.authorize();
    return result;
  }
  private async resolve(
    config: z.output<typeof oauthConfigurationSchema>,
    context: OAuthContext,
    binding: string,
  ): Promise<string> {
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    const directory = await realpath(this.options.directory),
      info = await lstat(directory);
    if ((process.platform !== "win32" && (info.mode & 0o077) !== 0) || !info.isDirectory())
      throw new IntegrationError("configuration", "OAuth-Vault muss ein privates Verzeichnis sein.");
    const slot = hash(canonical({ profileId: config.id, scope: context.scope }));
    const file = path.join(directory, slot + ".json"),
      lockFile = file + ".lock";
    let lock;
    try {
      lock = await open(lockFile, "wx", 0o600);
    } catch {
      throw new IntegrationError(
        "conflict",
        "OAuth-Zugang wird erneuert oder benötigt nach einem Abbruch einen administrativen Sperrabgleich.",
      );
    }
    const owner = randomUUID();
    await lock.writeFile(owner);
    await lock.sync();
    const owned = await lock.stat();
    try {
      const rawKey = await this.options.secrets.resolve(config.encryptionKeyRef, context.reason),
        key = Buffer.from(rawKey, "base64");
      if (key.length !== 32 || key.toString("base64") !== rawKey)
        throw new IntegrationError("configuration", "OAuth-Vault-Schlüssel muss exakt32Bytes in Base64 enthalten.");
      let state: State;
      try {
        const envelope = JSON.parse((await readRegular(file, 256 * 1024)).toString());
        const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
        decipher.setAAD(Buffer.from(binding));
        decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
        state = stateSchema.parse(
          JSON.parse(
            Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]).toString(),
          ),
        );
        if (state.binding !== binding) throw failure();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw failure();
        const refreshToken = token.parse(await this.options.secrets.resolve(config.refreshTokenRef, context.reason));
        state = { version: 1, binding, status: "ready", refreshToken, scopes: config.scopes, generation: 0 };
      }
      if (state.status !== "ready") throw failure(true);
      const now = this.options.now?.() ?? Date.now();
      if (state.accessToken && state.expiresAt && state.expiresAt > now + 60000) return state.accessToken;
      const clientSecret = config.clientSecretRef
        ? token.parse(await this.options.secrets.resolve(config.clientSecretRef, context.reason))
        : undefined;
      const ca = config.tlsCaFile ? await readRegular(config.tlsCaFile, 1024 * 1024) : undefined;
      await context.authorize();
      const save = async (next: State) => {
        const iv = randomBytes(12),
          cipher = createCipheriv("aes-256-gcm", key, iv);
        cipher.setAAD(Buffer.from(binding));
        const ciphertext = Buffer.concat([cipher.update(JSON.stringify(next)), cipher.final()]);
        const temp = file + "." + randomUUID() + ".tmp",
          handle = await open(temp, "wx", 0o600);
        try {
          await handle.writeFile(
            JSON.stringify({
              version: 1,
              iv: iv.toString("base64"),
              tag: cipher.getAuthTag().toString("base64"),
              ciphertext: ciphertext.toString("base64"),
            }),
          );
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temp, file);
        if (process.platform !== "win32") {
          const dir = await open(directory, "r");
          try {
            await dir.sync();
          } finally {
            await dir.close();
          }
        }
      };
      // Persist before network dispatch. A crash or ambiguous rotation must never reuse the old token.
      await save({ ...state, status: "refreshing" });
      let response: { status: number; body: Buffer };
      try {
        await context.authorize();
      } catch (error) {
        await save(state);
        throw error;
      }
      try {
        response = await refresh(config, state.refreshToken, clientSecret, ca);
      } catch {
        throw failure(true);
      }
      if (response.status !== 200) {
        // No response body is logged or surfaced: providers may echo submitted credentials.
        await save({ ...state, status: "reauthorization_required", accessToken: undefined, expiresAt: undefined });
        throw failure();
      }
      try {
        const result = z
          .object({
            access_token: token,
            token_type: z.string().refine((v) => v.toLowerCase() === "bearer"),
            expires_in: z
              .number()
              .int()
              .min(1)
              .max(366 * 86400),
            refresh_token: token.optional(),
            scope: z.string().optional(),
          })
          .parse(JSON.parse(response.body.toString()));
        const scopes = result.scope?.split(/ +/).filter(Boolean) ?? state.scopes;
        if (scopes.some((s) => !config.scopes.includes(s)) || config.scopes.some((s) => !scopes.includes(s)))
          throw failure();
        state = {
          ...state,
          status: "ready",
          accessToken: result.access_token,
          refreshToken: result.refresh_token ?? state.refreshToken,
          expiresAt: now + result.expires_in * 1000,
          scopes,
          generation: state.generation + 1,
        };
        await save(state);
      } catch {
        throw failure(true);
      }
      await context.authorize();
      return state.accessToken!;
    } finally {
      await lock.close();
      const current = await lstat(lockFile).catch(() => undefined);
      if (current?.ino === owned.ino && current.dev === owned.dev && current.isFile()) {
        const contents = await readRegular(lockFile, 100).catch(() => Buffer.alloc(0));
        if (contents.toString() === owner) await unlink(lockFile);
      }
    }
  }
}
function refresh(
  config: z.output<typeof oauthConfigurationSchema>,
  refreshToken: string,
  clientSecret: string | undefined,
  ca: Buffer | undefined,
): Promise<{ status: number; body: Buffer }> {
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    scope: config.scopes.join(" "),
  });
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
  };
  if (config.clientAuthentication === "client_secret_basic") {
    const encode = (v: string) => new URLSearchParams({ v }).toString().slice(2);
    headers.authorization =
      "Basic " + Buffer.from(encode(config.clientId) + ":" + encode(clientSecret!)).toString("base64");
  } else {
    form.set("client_id", config.clientId);
    if (config.clientAuthentication === "client_secret_post") form.set("client_secret", clientSecret!);
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, result?: { status: number; body: Buffer }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result!);
    };
    const req = https.request(
      config.tokenEndpoint,
      { method: "POST", agent: false, rejectUnauthorized: true, ca, headers },
      (res) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 128 * 1024) {
            finish(failure(true));
            req.destroy();
            res.destroy();
          } else chunks.push(chunk);
        });
        res.on("error", () => finish(failure(true)));
        res.on("end", () => finish(undefined, { status: res.statusCode ?? 502, body: Buffer.concat(chunks) }));
      },
    );
    const timer = setTimeout(() => {
      finish(failure(true));
      req.destroy();
    }, config.timeoutMs);
    req.on("error", () => finish(failure(true)));
    req.end(form.toString());
  });
}
