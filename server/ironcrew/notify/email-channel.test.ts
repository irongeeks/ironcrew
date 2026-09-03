import { describe, it, expect, vi } from "vitest";
import { EmailChannel } from "./email-channel.ts";

function fakeTransport(opts: { sendMail?: () => Promise<unknown>; verify?: () => Promise<true> }) {
  const sendMail = vi.fn(opts.sendMail ?? (async () => ({})));
  const verify = vi.fn(opts.verify ?? (async () => true as const));
  return { sendMail, verify };
}

describe("EmailChannel", () => {
  it("sends a message with the notification's title as the subject", async () => {
    const transport = fakeTransport({});
    const channel = new EmailChannel({
      host: "smtp.example.com",
      port: 587,
      user: "bot@example.com",
      pass: "secret",
      from: "IronCrew <bot@example.com>",
      to: "owner@example.com",
      createTransport: () => transport as never,
    });

    await channel.send({ title: "Freigabe nötig", body: "4.500 EUR Überweisung", severity: "critical" });

    expect(transport.sendMail).toHaveBeenCalledWith({
      from: "IronCrew <bot@example.com>",
      to: "owner@example.com",
      subject: "[IronCrew] Freigabe nötig",
      text: "4.500 EUR Überweisung",
    });
  });

  it("propagates a send failure", async () => {
    const transport = fakeTransport({
      sendMail: async () => {
        throw new Error("connection refused");
      },
    });
    const channel = new EmailChannel({
      host: "smtp.example.com",
      port: 587,
      from: "a@example.com",
      to: "b@example.com",
      createTransport: () => transport as never,
    });
    await expect(channel.send({ title: "x", body: "y", severity: "info" })).rejects.toThrow("connection refused");
  });

  it("testConnection reports ok when verify succeeds", async () => {
    const transport = fakeTransport({});
    const channel = new EmailChannel({
      host: "smtp.example.com",
      port: 587,
      from: "a@example.com",
      to: "b@example.com",
      createTransport: () => transport as never,
    });
    const status = await channel.testConnection();
    expect(status.ok).toBe(true);
    expect(status.message).toContain("smtp.example.com:587");
  });

  it("testConnection reports not-ok when verify fails", async () => {
    const transport = fakeTransport({
      verify: async () => {
        throw new Error("auth failed");
      },
    });
    const channel = new EmailChannel({
      host: "smtp.example.com",
      port: 587,
      from: "a@example.com",
      to: "b@example.com",
      createTransport: () => transport as never,
    });
    const status = await channel.testConnection();
    expect(status.ok).toBe(false);
    expect(status.message).toBe("auth failed");
  });

  it("defaults secure to true only for port 465", async () => {
    let capturedOpts: { secure?: boolean } = {};
    const channel = new EmailChannel({
      host: "smtp.example.com",
      port: 465,
      from: "a@example.com",
      to: "b@example.com",
      createTransport: (opts) => {
        capturedOpts = opts;
        return fakeTransport({}) as never;
      },
    });
    void channel;
    expect(capturedOpts.secure).toBe(true);
  });
});
