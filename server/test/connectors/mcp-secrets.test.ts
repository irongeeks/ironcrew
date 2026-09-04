import { describe, expect, it } from "vitest";
import {
  collectSecretRefs,
  configHasSecretRefs,
  isSecretRefValue,
  materializeMcpConfig,
  McpSecretError,
  McpSecretRefSchema,
} from "../../connectors/built-in/mcp/mcp-secrets.ts";
import type { SecretRef } from "../../ironcrew/secrets/secret-ref.ts";

function ref(itemRef: string, field?: string) {
  return { $secret: { provider: "vaultwarden" as const, itemRef, ...(field ? { field } : {}) } };
}

/** A vault that answers from a table, and records what it was asked for. */
function vault(items: Record<string, string>) {
  const asked: SecretRef[] = [];
  return {
    asked,
    resolve: async (r: SecretRef): Promise<string> => {
      asked.push(r);
      const key = r.field ? `${r.itemRef}#${r.field}` : r.itemRef;
      if (!(key in items)) throw new Error(`no such item: ${key}`);
      return items[key]!;
    },
  };
}

describe("McpSecretRefSchema", () => {
  it("accepts a reference naming a provider and an item", () => {
    expect(McpSecretRefSchema.safeParse(ref("GitHub MCP", "password").valueOf()).success).toBe(true);
  });

  it("rejects an unknown provider — a typo must not silently become a literal", () => {
    const result = McpSecretRefSchema.safeParse({ $secret: { provider: "1password", itemRef: "x" } });
    expect(result.success).toBe(false);
  });

  it("rejects an empty itemRef", () => {
    expect(McpSecretRefSchema.safeParse({ $secret: { provider: "keychain", itemRef: "" } }).success).toBe(false);
  });

  it("does not mistake a plain string for a reference", () => {
    expect(isSecretRefValue("ghp_literal")).toBe(false);
    expect(isSecretRefValue({ $secret: "GitHub" })).toBe(false);
  });
});

describe("collectSecretRefs", () => {
  it("finds references in env and headers, and ignores literals", () => {
    const refs = collectSecretRefs({
      name: "s",
      env: { NODE_ENV: "production", GITHUB_TOKEN: ref("GitHub MCP", "password") },
      headers: { Authorization: ref("API Gateway") },
    });
    expect(refs).toEqual([
      { provider: "vaultwarden", itemRef: "GitHub MCP", field: "password" },
      { provider: "vaultwarden", itemRef: "API Gateway" },
    ]);
  });

  it("returns nothing for a config that is all literals", () => {
    expect(configHasSecretRefs({ name: "s", env: { A: "1" } })).toBe(false);
    expect(configHasSecretRefs({ name: "s" })).toBe(false);
  });
});

describe("materializeMcpConfig", () => {
  it("replaces references with values and leaves literals alone", async () => {
    const v = vault({ "GitHub MCP#password": "ghp_real" });
    const { config, secretValues } = await materializeMcpConfig(
      { name: "github", env: { NODE_ENV: "production", GITHUB_TOKEN: ref("GitHub MCP", "password") } },
      v.resolve,
    );
    expect(config.env).toEqual({ NODE_ENV: "production", GITHUB_TOKEN: "ghp_real" });
    expect(secretValues).toEqual(["ghp_real"]);
  });

  it("leaves the caller's config untouched, so a save-back cannot persist the value", async () => {
    const original = { name: "github", env: { GITHUB_TOKEN: ref("GitHub MCP", "password") } };
    const v = vault({ "GitHub MCP#password": "ghp_real" });
    await materializeMcpConfig(original, v.resolve);
    expect(original.env.GITHUB_TOKEN).toEqual(ref("GitHub MCP", "password"));
    expect(JSON.stringify(original)).not.toContain("ghp_real");
  });

  it("resolves headers too", async () => {
    const v = vault({ "API Gateway": "Bearer abc" });
    const { config } = await materializeMcpConfig(
      { name: "gw", headers: { Authorization: ref("API Gateway") } },
      v.resolve,
    );
    expect(config.headers).toEqual({ Authorization: "Bearer abc" });
  });

  it("keeps an absent env absent rather than inventing an empty one", async () => {
    const { config } = await materializeMcpConfig({ name: "s" }, async () => "unused");
    expect(config.env).toBeUndefined();
    expect(config.headers).toBeUndefined();
  });

  it("names the key and the item when the vault fails — and never the value", async () => {
    const v = vault({});
    await expect(
      materializeMcpConfig({ name: "github", env: { GITHUB_TOKEN: ref("Missing Item", "password") } }, v.resolve),
    ).rejects.toThrow(McpSecretError);

    let message = "";
    try {
      await materializeMcpConfig({ name: "github", env: { GITHUB_TOKEN: ref("Missing Item", "password") } }, v.resolve);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("env.GITHUB_TOKEN");
    expect(message).toContain("Missing Item");
    expect(message).toContain("vaultwarden");
  });

  it("refuses an empty value — that is a wrong field name, not an empty password", async () => {
    const v = vault({ "GitHub MCP#note": "" });
    await expect(
      materializeMcpConfig({ name: "github", env: { GITHUB_TOKEN: ref("GitHub MCP", "note") } }, v.resolve),
    ).rejects.toThrow(/empty value/);
  });

  it("never resolves anything for a config without references", async () => {
    const v = vault({});
    const { secretValues } = await materializeMcpConfig({ name: "s", env: { A: "1" } }, v.resolve);
    expect(v.asked).toEqual([]);
    expect(secretValues).toEqual([]);
  });
});
