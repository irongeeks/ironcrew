import { describe, expect, it } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  ProtonPassResolver,
  isPublicAddress,
  validatePublicUrl,
  verifyDiscordInbound,
  verifyTelegramInbound,
  redact,
  IntegrationService,
} from "../../packages/integrations/src/index.ts";

describe("integration security boundaries", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "169.254.169.254",
    "172.16.1.2",
    "192.168.1.2",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "fe80::1",
    "2001:db8::1",
    "2002:7f00:1::",
  ])("blocks nonpublic address %s", (address) => expect(isPublicAddress(address)).toBe(false));
  it("accepts ordinary public IPv4 and IPv6", () => {
    expect(isPublicAddress("8.8.8.8")).toBe(true);
    expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
  });
  it("rejects private/mixed DNS answers, credentials and nonpublic ports", async () => {
    await expect(
      validatePublicUrl("https://example.org", async () => [
        { address: "8.8.8.8", family: 4 },
        { address: "10.0.0.1", family: 4 },
      ]),
    ).rejects.toMatchObject({ code: "ssrf" });
    await expect(validatePublicUrl("https://user:secret@example.org")).rejects.toMatchObject({ code: "ssrf" });
    await expect(validatePublicUrl("http://2130706433")).rejects.toMatchObject({
      code: "ssrf",
    });
    await expect(validatePublicUrl("https://example.org:8443")).rejects.toMatchObject({ code: "ssrf" });
  });
  it("pins a single DNS resolution result for transport selection", async () => {
    let calls = 0;
    const result = await validatePublicUrl("https://example.org", async () => {
      calls++;
      return [{ address: "8.8.8.8", family: 4 }];
    });
    expect(calls).toBe(1);
    expect(result.addresses[0].address).toBe("8.8.8.8");
  });
  it.each(["  exact secret  ", "secret\r", "line one\r\nline two\n"])(
    "accepts official Proton CLI output and preserves selected-field whitespace: %j",
    async (secret) => {
      const calls: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
      const provider = new ProtonPassResolver({
        executable: "/opt/ironcrew/pass-cli",
        environment: {
          HOME: "/broker",
          PROTON_PASS_SESSION_DIR: "/broker/session",
          DANGEROUS_SECRET: "never",
          NODE_OPTIONS: "bad",
        },
        run: async (_file, args, options) => {
          calls.push({ args, env: options.env });
          return args[0] === "--version" ? "Proton Pass CLI 2.3.2 (ac04625)\n" : secret + "\n";
        },
      });
      const result = await provider.resolve(
        {
          provider: "proton-pass",
          shareId: "vault",
          itemId: "item",
          field: "password",
        },
        "Action 1: connector access",
      );
      expect(result).toBe(secret);
      expect(calls[1].args).toEqual(["item", "view", "--share-id=vault", "--item-id=item", "--field=password"]);
      expect(calls[1].env.PROTON_PASS_AGENT_REASON).toBe("Action 1: connector access");
      expect(calls[1].env.DANGEROUS_SECRET).toBeUndefined();
      expect(calls[1].env.NODE_OPTIONS).toBeUndefined();
    },
  );
  it.each([
    "2.3.2",
    "pass-cli 2.3.2\n",
    "Proton Pass CLI 2.3.2\r\n",
    "Proton Pass CLI 2.3.10 (abcdef0)",
    "pass-cli 2.4.0",
    "Proton Pass CLI 3.0.0 (0123456)",
  ])("accepts supported stable Proton release %s", async (version) => {
    const provider = new ProtonPassResolver({
      executable: "/opt/ironcrew/pass-cli",
      environment: {},
      run: async (_file, args) => (args[0] === "--version" ? version : "secret\n"),
    });
    await expect(
      provider.resolve(
        {
          provider: "proton-pass",
          shareId: "vault",
          itemId: "item",
          field: "password",
        },
        "access",
      ),
    ).resolves.toBe("secret");
  });
  it.each([
    "pass-cli 2.3.1",
    "Proton Pass CLI 2.2.99 (ac04625)",
    "pass-cli 1.99.99",
    "Proton Pass CLI 2.3.2-rc.1 (ac04625)",
    "pass-cli 3.0.0-beta.1",
    "pass-cli 2.3",
    "pass-cli 02.3.2",
    "pass-cli 9007199254740992.0.0",
    "unrelated-cli 2.3.2",
    "Proton Pass CLI 2.3.2 (not-a-revision)",
    "Proton Pass CLI 2.3.2\nunexpected output",
    "",
  ])("refuses unsupported Proton output before reading any secret: %s", async (version) => {
    const calls: string[][] = [];
    const provider = new ProtonPassResolver({
      executable: "/opt/ironcrew/pass-cli",
      environment: {},
      run: async (_file, args) => {
        calls.push(args);
        return version;
      },
    });
    await expect(
      provider.resolve(
        {
          provider: "proton-pass",
          shareId: "vault",
          itemId: "item",
          field: "password",
        },
        "access",
      ),
    ).rejects.toMatchObject({ code: "configuration" });
    expect(calls).toEqual([["--version"]]);
  });
  it("refuses unsupported Proton binaries and never exposes runner stderr", async () => {
    const ref = {
      provider: "proton-pass" as const,
      shareId: "vault",
      itemId: "item",
      field: "password",
    };
    await expect(
      new ProtonPassResolver({
        executable: "/bin/pass-cli",
        environment: {},
        run: async () => "pass-cli 0.0.0",
      }).resolve(ref, "reason"),
    ).rejects.toMatchObject({ code: "configuration" });
    try {
      await new ProtonPassResolver({
        executable: "/bin/pass-cli",
        environment: {},
        run: async () => {
          throw new Error("stderr TOKEN_PRIVATE");
        },
      }).resolve(ref, "reason");
    } catch (error) {
      expect(String(error)).not.toContain("TOKEN_PRIVATE");
      expect(error).toMatchObject({ code: "auth" });
    }
  });
  it("redacts short secrets, nested values, keys and overlapping secrets", () => {
    expect(redact({ abcdef: "abc", nested: ["abcdef"] }, ["abc", "abcdef"])).toEqual({
      "[REDACTED]": "[REDACTED]",
      nested: ["[REDACTED]"],
    });
  });
  it("preserves nested mail dates through redaction and persisted JSON evidence", () => {
    const sent = new Date("2026-09-08T07:00:00.000Z");
    const received = new Date("2026-09-08T07:01:12.000Z");
    const result = redact(
      { messages: [{ envelope: { date: sent, subject: "secret subject" }, receivedAt: received }] },
      ["secret"],
    );
    expect(result.messages[0]!.envelope.date).toBeInstanceOf(Date);
    expect(result.messages[0]!.envelope.date).not.toBe(sent);
    expect(JSON.parse(JSON.stringify(result))).toEqual({
      messages: [
        { envelope: { date: sent.toISOString(), subject: "[REDACTED] subject" }, receivedAt: received.toISOString() },
      ],
    });
    expect(sent.toISOString()).toBe("2026-09-08T07:00:00.000Z");
    expect(JSON.stringify(redact({ date: new Date(NaN) }, []))).toBe('{"date":null}');
  });
  it("validates Telegram secret before parsing provider event", () => {
    const body = Buffer.from(
      JSON.stringify({
        update_id: 10,
        message: {
          message_id: 2,
          date: 1809756000,
          text: "Please approve",
          from: { id: 99 },
          chat: { id: 42 },
        },
      }),
    );
    expect(() => verifyTelegramInbound(body, "wrong", "secret")).toThrow();
    const result = verifyTelegramInbound(body, "secret", "secret");
    expect(result.senderId).toBe("99");
    expect(result.externalId).toBe("10");
    expect(result).not.toHaveProperty("ceoId");
  });
  it("verifies Discord raw-body signature and prevents timestamp replay", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicHex = publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("hex");
    const now = 1809756000000;
    const timestamp = String(now / 1000);
    const body = Buffer.from(
      JSON.stringify({
        id: "123456",
        type: 2,
        channel_id: "42",
        user: { id: "99" },
        data: { name: "order", options: [{ name: "goal", value: "inspect" }] },
      }),
    );
    const signature = sign(null, Buffer.concat([Buffer.from(timestamp), body]), privateKey).toString("hex");
    expect(verifyDiscordInbound(body, signature, timestamp, publicHex, now)).toMatchObject({
      senderId: "99",
      externalId: "123456",
    });
    expect(() => verifyDiscordInbound(Buffer.from("{}"), signature, timestamp, publicHex, now)).toThrow();
    expect(() => verifyDiscordInbound(body, signature, timestamp, publicHex, now + 301000)).toThrow();
  });
  it("denies traversal and obsolete authorization before resolving a secret", async () => {
    let resolutions = 0;
    let authorization = 0;
    const scope = { companyId: "a", areaId: "b" };
    const service = new IntegrationService({
      connections: [
        {
          id: "target",
          provider: "nextcloud",
          scope,
          baseUrl: "https://example.org",
          username: "operator",
          enabledTools: ["nextcloud.write"],
          schemaTag: "fixture",
          secretRef: {
            provider: "proton-pass",
            shareId: "s",
            itemId: "i",
            field: "p",
          },
        },
      ],
      authorize: async () => {
        authorization++;
        throw new Error("revoked");
      },
      secrets: {
        resolve: async () => {
          resolutions++;
          return "secret";
        },
      },
    });
    const action = {
      id: "action",
      targetId: "target",
      toolId: "nextcloud.write",
      scope,
      args: { path: "../outside", content: "x", createOnly: true },
    };
    await expect(service.execute(action)).rejects.toMatchObject({
      code: "validation",
    });
    expect(authorization).toBe(0);
    await expect(
      service.execute({
        ...action,
        args: { path: "allowed", content: "x", createOnly: true },
      }),
    ).rejects.toThrow("revoked");
    expect(resolutions).toBe(0);
  });
});
