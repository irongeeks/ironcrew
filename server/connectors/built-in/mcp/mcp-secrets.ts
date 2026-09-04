/**
 * MCP credentials as references, not as values.
 *
 * An MCP server is configured with `env` (for stdio) or `headers` (for HTTP)
 * — and in practice that is where the API key goes. Those configs live in the
 * `settings` table as JSON, which means a literal value there is a plaintext
 * credential in the database: exactly what docs/THREAT_MODEL.md forbids
 * ("only SecretRef values are stored in the database — never plaintext").
 *
 * So a value may be either a literal string (fine for `NODE_ENV=production`)
 * or a reference of the shape:
 *
 *     { "$secret": { "provider": "vaultwarden", "itemRef": "GitHub MCP", "field": "password" } }
 *
 * A reference names *where* the secret lives. It is not itself sensitive, so
 * it may be stored, logged and shown in the UI. The value is fetched from the
 * vault immediately before the server is started, held in memory for the life
 * of that transport, and never written back.
 *
 * WHERE THE FETCH HAPPENS MATTERS MORE THAN THAT IT HAPPENS
 *
 * Resolving here, in the control plane, would only move the plaintext from
 * the database into the control plane's memory — the process this project is
 * deliberately keeping credential-free (T-05, T-17). So the control plane
 * refuses to start a server whose config carries references and hands the
 * whole config to the runner instead; the runner resolves it as its own OS
 * user, against its own vault session, and returns only tool results. This
 * module is shared by both sides so that neither invents its own idea of what
 * a reference looks like.
 */

import { z } from "zod/v4";
import type { SecretRef } from "../../../ironcrew/secrets/secret-ref.ts";

export const McpSecretRefSchema = z.object({
  $secret: z.object({
    provider: z.enum(["vaultwarden", "protonpass", "keychain"]),
    itemRef: z.string().min(1),
    field: z.string().min(1).optional(),
  }),
});

/** Either a literal, or a pointer into a vault. Never a literal that is secret. */
export const McpConfigValueSchema = z.union([z.string(), McpSecretRefSchema]);

export type McpSecretRefValue = z.infer<typeof McpSecretRefSchema>;
export type McpConfigValue = z.infer<typeof McpConfigValueSchema>;

export type McpValueMap = Record<string, McpConfigValue>;
/** The same map after resolution — what a transport actually gets. */
export type ResolvedValueMap = Record<string, string>;

export class McpSecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpSecretError";
  }
}

export function isSecretRefValue(value: unknown): value is McpSecretRefValue {
  return McpSecretRefSchema.safeParse(value).success;
}

/** The shape this module needs from a config; the full one lives in mcp-config.ts. */
interface SecretBearingConfig {
  name: string;
  env?: McpValueMap;
  headers?: McpValueMap;
}

/**
 * Every reference in a config, in a stable order.
 *
 * Used to decide *where* a server may be started, and by the runner to
 * pre-warm and to build the redaction list — never to display a value.
 */
export function collectSecretRefs(config: SecretBearingConfig): SecretRef[] {
  const refs: SecretRef[] = [];
  for (const map of [config.env, config.headers]) {
    if (!map) continue;
    for (const key of Object.keys(map).sort()) {
      const value = map[key];
      if (isSecretRefValue(value)) refs.push(value.$secret);
    }
  }
  return refs;
}

export function configHasSecretRefs(config: SecretBearingConfig): boolean {
  return collectSecretRefs(config).length > 0;
}

/**
 * Resolves one map of values.
 *
 * A failure names the key and the vault item, never the value — an error
 * message is the one place a secret leaks without anybody noticing, because
 * it travels into logs, into the UI, and often into a bug report.
 */
async function resolveMap(
  serverName: string,
  where: "env" | "headers",
  map: McpValueMap | undefined,
  resolve: (ref: SecretRef) => Promise<string>,
): Promise<{ resolved: ResolvedValueMap; secrets: string[] }> {
  const resolved: ResolvedValueMap = {};
  const secrets: string[] = [];
  if (!map) return { resolved, secrets };

  for (const [key, value] of Object.entries(map)) {
    if (typeof value === "string") {
      resolved[key] = value;
      continue;
    }
    let fetched: string;
    try {
      fetched = await resolve(value.$secret);
    } catch (err) {
      throw new McpSecretError(
        `MCP server "${serverName}": could not resolve ${where}.${key} from ${value.$secret.provider} ` +
          `item "${value.$secret.itemRef}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (fetched === "") {
      // An empty value is almost always a wrong field name rather than an
      // empty password, and it would otherwise surface as an opaque 401 from
      // the MCP server hours later.
      throw new McpSecretError(
        `MCP server "${serverName}": ${where}.${key} resolved to an empty value from ${value.$secret.provider} ` +
          `item "${value.$secret.itemRef}" — check the field name.`,
      );
    }
    resolved[key] = fetched;
    secrets.push(fetched);
  }
  return { resolved, secrets };
}

export interface MaterializedMcpConfig<T> {
  /** The same config, with every reference replaced by its value. */
  config: T & { env?: ResolvedValueMap; headers?: ResolvedValueMap };
  /** The resolved values, for redaction. Never persist or log these. */
  secretValues: string[];
}

/**
 * Turns a stored config into one a transport can use.
 *
 * The returned object is a copy: the caller's config keeps its references, so
 * a config that is saved back to the database after a connection attempt
 * cannot accidentally carry a plaintext value with it.
 */
export async function materializeMcpConfig<T extends SecretBearingConfig>(
  config: T,
  resolve: (ref: SecretRef) => Promise<string>,
): Promise<MaterializedMcpConfig<T>> {
  const env = await resolveMap(config.name, "env", config.env, resolve);
  const headers = await resolveMap(config.name, "headers", config.headers, resolve);

  const materialized = { ...config } as T & { env?: ResolvedValueMap; headers?: ResolvedValueMap };
  if (config.env) materialized.env = env.resolved;
  if (config.headers) materialized.headers = headers.resolved;

  return { config: materialized, secretValues: [...env.secrets, ...headers.secrets] };
}
