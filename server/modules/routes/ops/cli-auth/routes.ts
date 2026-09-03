import type { Express } from "express";
import type { UtilContext } from "../../../../types/runtime-context-domains.ts";
import { CliAuthRunner } from "./cli-auth-runner.ts";
import { validateCliApiKey } from "./api-key-validation.ts";
import { toErrorMessage } from "../../validation.ts";

const VALID_PROVIDERS = ["claude", "codex", "gemini"];

export interface CliAuthRouteDeps {
  app: Express;
  detectAllCli: UtilContext["detectAllCli"];
}

export function registerCliAuthRoutes(ctx: CliAuthRouteDeps) {
  const { app, detectAllCli } = ctx;
  const runner = new CliAuthRunner({ detectAllCli });

  app.post("/api/ops/cli-auth/:provider/start", async (req, res) => {
    const { provider } = req.params;
    if (!VALID_PROVIDERS.includes(provider)) {
      return res.status(400).json({ error: `Unsupported provider: ${provider}` });
    }
    try {
      const result = await runner.startSession(provider);
      res.json(result);
    } catch (err: unknown) {
      const message = toErrorMessage(err);
      if (message.includes("already running")) {
        return res.status(409).json({ error: message });
      }
      res.status(400).json({ error: message || "Failed to start auth session" });
    }
  });

  app.get("/api/ops/cli-auth/:provider/status/:sessionId", async (req, res) => {
    const { provider, sessionId } = req.params;
    const status = await runner.getStatus(provider, sessionId);
    res.json(status);
  });

  app.post("/api/ops/cli-auth/:provider/input/:sessionId", (req, res) => {
    const { provider, sessionId } = req.params;
    const { input } = req.body;
    if (!input || typeof input !== "string") {
      return res.status(400).json({ error: "Missing input" });
    }
    const result = runner.sendInput(provider, sessionId, input);
    res.json(result);
  });

  app.post("/api/ops/cli-auth/:provider/cancel/:sessionId", (req, res) => {
    const { provider, sessionId } = req.params;
    const result = runner.cancelSession(provider, sessionId);
    res.json(result);
  });

  // Codex-only: save API key directly
  app.post("/api/ops/cli-auth/codex/api-key", async (req, res) => {
    let apiKey: string;
    try {
      apiKey = validateCliApiKey("codex", req.body?.apiKey);
    } catch (err) {
      return res.status(400).json({ error: err instanceof Error ? err.message : "invalid API key" });
    }
    try {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const os = await import("node:os");
      const codexDir = path.join(os.homedir(), ".codex");
      if (!fs.existsSync(codexDir)) fs.mkdirSync(codexDir, { recursive: true });
      const authPath = path.join(codexDir, "auth.json");
      let existing: Record<string, unknown> = {};
      try {
        existing = JSON.parse(fs.readFileSync(authPath, "utf8"));
      } catch {
        /* no existing file */
      }
      existing.OPENAI_API_KEY = apiKey;
      fs.writeFileSync(authPath, JSON.stringify(existing, null, 2));

      const cliResult = await detectAllCli();
      const authenticated = cliResult.codex?.authenticated ?? false;
      res.json({ authenticated });
    } catch (err: unknown) {
      res.status(500).json({ error: toErrorMessage(err) || "Failed to save API key" });
    }
  });

  // Claude: save Anthropic API key — written to .env and injected into process.env
  // so agents pick it up immediately without a server restart.
  app.post("/api/ops/cli-auth/claude/api-key", async (req, res) => {
    let apiKey: string;
    try {
      apiKey = validateCliApiKey("claude", req.body?.apiKey);
    } catch (err) {
      return res.status(400).json({ error: err instanceof Error ? err.message : "invalid API key" });
    }
    try {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const envPath = path.resolve(".env");

      // Read existing .env content
      let envContent = "";
      try {
        envContent = fs.readFileSync(envPath, "utf8");
      } catch {
        /* .env may not exist yet */
      }

      // Replace or append ANTHROPIC_API_KEY line
      const keyLine = `ANTHROPIC_API_KEY=${apiKey}`;
      if (/^ANTHROPIC_API_KEY=.*/m.test(envContent)) {
        envContent = envContent.replace(/^ANTHROPIC_API_KEY=.*/m, keyLine);
      } else {
        envContent = envContent.trimEnd() + "\n" + keyLine + "\n";
      }
      fs.writeFileSync(envPath, envContent);

      // Inject immediately so current process and child spawns see it right away
      process.env.ANTHROPIC_API_KEY = apiKey;

      const cliResult = await detectAllCli();
      const authenticated = cliResult.claude?.authenticated ?? false;
      res.json({ authenticated });
    } catch (err: unknown) {
      res.status(500).json({ error: toErrorMessage(err) || "Failed to save API key" });
    }
  });
}
