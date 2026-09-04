/**
 * The one piece of the MCP form with a rule behind it: what a row becomes.
 *
 * A row the operator marked "Tresor" must leave the browser as a reference,
 * never as a value — that is the whole point of the runner arrangement
 * (server/connectors/built-in/mcp/mcp-secrets.ts). A silent fallback to a
 * literal here would put a credential back in the settings table without
 * anybody noticing.
 */

import { describe, it, expect } from "vitest";
import { credentialsToMap } from "./McpSettingsTab";

const row = {
  key: "GITHUB_TOKEN",
  mode: "secret" as const,
  value: "",
  provider: "vaultwarden" as const,
  itemRef: "GitHub MCP",
  field: "password",
};

describe("credentialsToMap", () => {
  it("turns a vault row into a reference, not a value", () => {
    expect(credentialsToMap([row])).toEqual({
      GITHUB_TOKEN: { $secret: { provider: "vaultwarden", itemRef: "GitHub MCP", field: "password" } },
    });
  });

  it("omits an empty field rather than sending one the provider would not understand", () => {
    expect(credentialsToMap([{ ...row, field: "  " }])).toEqual({
      GITHUB_TOKEN: { $secret: { provider: "vaultwarden", itemRef: "GitHub MCP" } },
    });
  });

  it("keeps a literal row a literal — not every env value is a credential", () => {
    expect(credentialsToMap([{ ...row, key: "NODE_ENV", mode: "literal", value: "production" }])).toEqual({
      NODE_ENV: "production",
    });
  });

  it("drops rows without a key, so a half-typed row does not break the save", () => {
    expect(credentialsToMap([{ ...row, key: "   " }])).toBeUndefined();
  });

  it("trims the item reference — a trailing space is a vault lookup that fails at 3am", () => {
    const map = credentialsToMap([{ ...row, itemRef: " GitHub MCP " }]);
    expect(map).toEqual({
      GITHUB_TOKEN: { $secret: { provider: "vaultwarden", itemRef: "GitHub MCP", field: "password" } },
    });
  });

  it("returns undefined for no rows, so the config carries no empty map", () => {
    expect(credentialsToMap([])).toBeUndefined();
  });
});
