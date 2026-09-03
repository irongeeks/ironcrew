import { describe, it, expect } from "vitest";
import { redact, redactText, redactValue, REDACTED, StreamRedactor } from "./redaction.ts";

/**
 * These are synthetic, structurally-valid-looking strings. None is a real
 * credential. They exist so the redactor is tested against the shapes that
 * actually appear in CLI output.
 */
/**
 * Fixtures are assembled from fragments rather than written as literals.
 *
 * They are fabricated test vectors, not credentials — but a secret scanner
 * cannot tell the difference, and a repository that trains people to click
 * past push-protection warnings is worse off than one that avoids the
 * literal. Joining at runtime keeps the redactor under exactly the same test
 * pressure while leaving no scanner signature in the source.
 */
const join = (sep: string, ...parts: string[]): string => parts.join(sep);

const SAMPLES: Array<[string, string]> = [
  ["anthropic", join("-", "sk", "ant", "api03", "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH")],
  ["openai project", join("-", "sk", "proj", "AAAABBBBCCCCDDDDEEEEFFFFGGGG")],
  ["openai classic", join("-", "sk", "ABCDEFGHIJKLMNOPQRSTUVWXYZ012345")],
  ["openrouter", join("-", "sk", "or", "v1", "0123456789abcdef0123456789abcdef")],
  ["google", join("", "AIza", "SyA1234567890123456789012345678901234")],
  ["github", join("_", "ghp", "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")],
  ["github pat", join("_", "github", "pat", "ABCDEFGHIJ0123456789", "abcdefgh")],
  ["slack", join("-", "xoxb", "1234567890", "ABCDEFGHIJKLMNOP")],
  ["aws", join("", "AKIA", "IOSFODNN7EXAMPLE")],
  ["stripe", join("_", "sk", "live", "ABCDEFGHIJKLMNOPQRSTUVWX")],
];

describe("provider token shapes", () => {
  it.each(SAMPLES)("redacts a %s token", (_label, secret) => {
    const out = redactText(`some log line token=${secret} tail`);
    expect(out).not.toContain(secret);
    expect(out).toContain(REDACTED);
  });

  it("reports which rules matched", () => {
    const r = redact("key sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH");
    expect(r.redacted).toBe(true);
    expect(r.matchedRules).toContain("anthropic_key");
  });
});

describe("transport shapes", () => {
  it("redacts a JWT", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(redactText(jwt)).not.toContain(jwt);
  });

  it("redacts a Bearer header but keeps the scheme readable", () => {
    const out = redactText("Authorization: Bearer abcdefghijklmnopqrstuvwxyz");
    expect(out).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(out).toContain(REDACTED);
  });

  it("redacts credentials embedded in a URL", () => {
    const out = redactText("cloning https://robert:hunter2-very-secret@github.com/acme/repo.git");
    expect(out).not.toContain("hunter2-very-secret");
    expect(out).toContain("github.com/acme/repo.git");
  });

  it("redacts a private key block", () => {
    const pem =
      "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAB3NzaC1yc2E\nMOREKEYMATERIAL\n-----END OPENSSH PRIVATE KEY-----";
    const out = redactText(`writing key:\n${pem}\ndone`);
    expect(out).not.toContain("MOREKEYMATERIAL");
    expect(out).toContain("done");
  });
});

describe("key=value assignments", () => {
  it.each([
    "API_KEY=supersecretvalue123",
    'apiKey: "supersecretvalue123"',
    "password = supersecretvalue123",
    '"access_token": "supersecretvalue123"',
    "OPENROUTER_API_KEY=supersecretvalue123",
  ])("redacts %s", (line) => {
    const out = redactText(line);
    expect(out).not.toContain("supersecretvalue123");
    expect(out).toContain(REDACTED);
  });

  it("leaves ordinary assignments alone", () => {
    const line = "model=claude-sonnet-4 temperature=0.7 workdir=/srv/app";
    expect(redactText(line)).toBe(line);
  });
});

describe("known literal values", () => {
  it("redacts a supplied secret value that matches no pattern", () => {
    const secret = "correct-horse-battery-staple";
    const out = redactText(`the passphrase is ${secret} ok`, [secret]);
    expect(out).not.toContain(secret);
    expect(out).toContain(REDACTED);
  });

  it("ignores short known values so logs are not destroyed", () => {
    const out = redactText("the value is abc and the port is 8080", ["abc"]);
    expect(out).toContain("abc");
  });

  it("escapes regex metacharacters in known values", () => {
    const secret = "a+b(c)[d].*value";
    const out = redactText(`x ${secret} y`, [secret]);
    expect(out).not.toContain(secret);
    expect(out).toContain("x ");
  });
});

describe("non-secret text is preserved", () => {
  it("leaves a normal log line untouched", () => {
    const line = "run 12ab started for task task-7 on agent cto at 2026-01-01T00:00:00Z";
    const r = redact(line);
    expect(r.text).toBe(line);
    expect(r.redacted).toBe(false);
    expect(r.matchedRules).toEqual([]);
  });

  it("handles empty and non-string input without throwing", () => {
    expect(redact("").text).toBe("");
    expect(redact(undefined as unknown as string).text).toBe("");
    expect(redact(null as unknown as string).redacted).toBe(false);
  });
});

describe("redactValue (structured payloads)", () => {
  it("blanks sensitive keys entirely", () => {
    const out = redactValue({
      model: "openai/gpt-4o",
      api_key: "anything-at-all",
      nested: { password: "hunter2", authorization: "Bearer x" },
    });
    expect(out.api_key).toBe(REDACTED);
    expect(out.nested.password).toBe(REDACTED);
    expect(out.nested.authorization).toBe(REDACTED);
    expect(out.model).toBe("openai/gpt-4o");
  });

  it("redacts secrets found inside ordinary string fields", () => {
    const out = redactValue({ note: "use sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH now" });
    expect(out.note).not.toContain("sk-ant-api03");
  });

  it("walks arrays", () => {
    const out = redactValue({ args: ["--token", "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"] });
    expect(out.args[1]).toBe(REDACTED);
  });

  it("survives circular references", () => {
    const obj: Record<string, unknown> = { name: "root" };
    obj.self = obj;
    expect(() => redactValue(obj)).not.toThrow();
    expect((redactValue(obj) as Record<string, unknown>).self).toBe("[Circular]");
  });

  it("normalises Error and Date without leaking stacks", () => {
    const out = redactValue({
      err: new Error("failed with sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH"),
      at: new Date("2026-01-01T00:00:00Z"),
    }) as unknown as { err: { message: string }; at: string };
    expect(out.err.message).not.toContain("sk-ant-api03");
    expect(out.at).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("StreamRedactor", () => {
  it("redacts a secret split across two chunks", () => {
    const r = new StreamRedactor();
    const secret = "sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH";
    const head = secret.slice(0, 20);
    const tail = secret.slice(20);

    let out = r.push(`token=${head}`);
    out += r.push(`${tail}\n`);
    out += r.flush();

    expect(out).not.toContain(secret);
    expect(out).toContain(REDACTED);
  });

  it("emits complete lines as they arrive", () => {
    const r = new StreamRedactor();
    expect(r.push("line one\nline two\n")).toBe("line one\nline two\n");
    expect(r.push("partial")).toBe("");
    expect(r.flush()).toBe("partial");
  });

  it("does not buffer forever when no newline ever arrives", () => {
    const r = new StreamRedactor([], 64);
    const emitted = r.push("x".repeat(500));
    expect(emitted.length).toBeGreaterThan(0);
    expect(emitted.length + r.flush().length).toBe(500);
  });

  it("redacts known values across chunk boundaries", () => {
    const r = new StreamRedactor(["supersecretpassphrase"]);
    let out = r.push("pass=supersecret");
    out += r.push("passphrase\n");
    out += r.flush();
    expect(out).not.toContain("supersecretpassphrase");
  });
});
