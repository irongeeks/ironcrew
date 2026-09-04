import fs from "node:fs";
import path from "node:path";
import type { RuntimeContext } from "../../../types/runtime-context.ts";

type CheckResult = { ok: boolean; detail?: string };

function checkSecret(envContent: string, key: string): CheckResult {
  const match = envContent.match(new RegExp(`^${key}\\s*=\\s*(.*)$`, "m"));
  if (!match) return { ok: false, detail: `${key} not found in .env` };
  const value = match[1].trim().replace(/^['"]|['"]$/g, "");
  if (!value || value === "__CHANGE_ME__") return { ok: false, detail: `${key} not configured` };
  return { ok: true };
}

function deriveOverallStatus(checks: Record<string, CheckResult>): { required_ok: boolean; optional_ok: boolean } {
  const requiredKeys = [
    "database",
    "encryption_secret",
    "webhook_secret",
    "agents_seeded",
    "departments_seeded",
    "cli_provider_configured",
  ];
  const required_ok = requiredKeys.every((k) => checks[k]?.ok === true);
  const optional_ok = Object.values(checks).every((c) => c.ok === true);
  return { required_ok, optional_ok };
}

export function registerSetupStatusRoutes(ctx: RuntimeContext): void {
  const { app, db } = ctx;

  app.get("/api/ops/setup-status", (_req, res) => {
    try {
      // 1. Read .env for secret checks
      let envContent = "";
      try {
        envContent = fs.readFileSync(path.resolve(".env"), "utf8");
      } catch {
        // .env may not exist yet — checks will report not-ok
      }

      const checks: Record<string, CheckResult> = {};

      // 2. Database check
      try {
        db.prepare("SELECT 1").get();
        checks.database = { ok: true };
      } catch (err) {
        checks.database = { ok: false, detail: `Database unreachable: ${String(err)}` };
      }

      // 3. Secret checks
      checks.encryption_secret = checkSecret(envContent, "OAUTH_ENCRYPTION_SECRET");
      checks.webhook_secret = checkSecret(envContent, "INBOX_WEBHOOK_SECRET");

      // 4. Seed checks
      try {
        const agentRow = db.prepare("SELECT COUNT(*) AS cnt FROM agents").get() as { cnt: number } | undefined;
        const agentCount = agentRow?.cnt ?? 0;
        checks.agents_seeded = agentCount > 0 ? { ok: true } : { ok: false, detail: "No agents found — run setup" };
      } catch (err) {
        checks.agents_seeded = { ok: false, detail: `agents table error: ${String(err)}` };
      }

      try {
        const deptRow = db.prepare("SELECT COUNT(*) AS cnt FROM departments").get() as { cnt: number } | undefined;
        const deptCount = deptRow?.cnt ?? 0;
        checks.departments_seeded =
          deptCount > 0 ? { ok: true } : { ok: false, detail: "No departments found — run setup" };
      } catch (err) {
        checks.departments_seeded = { ok: false, detail: `departments table error: ${String(err)}` };
      }

      // 5. CLI provider check
      try {
        const providerRow = db.prepare("SELECT value FROM settings WHERE key = 'defaultProvider' LIMIT 1").get() as
          | { value?: string }
          | undefined;
        const provider = providerRow?.value?.trim() ?? "";
        checks.cli_provider_configured =
          provider.length > 0 ? { ok: true } : { ok: false, detail: "No default CLI provider configured in settings" };
      } catch (err) {
        checks.cli_provider_configured = { ok: false, detail: `settings table error: ${String(err)}` };
      }

      // 6. API key check (optional) — column is api_key_enc (encrypted)
      try {
        const apiRow = db.prepare("SELECT COUNT(*) AS cnt FROM api_providers WHERE api_key_enc IS NOT NULL").get() as
          | { cnt: number }
          | undefined;
        const apiCount = apiRow?.cnt ?? 0;
        checks.api_key_configured =
          apiCount > 0 ? { ok: true } : { ok: false, detail: "No API provider keys configured (optional)" };
      } catch {
        checks.api_key_configured = { ok: false, detail: "api_providers table unavailable (optional)" };
      }

      // 7. OAuth check (optional) — column is encrypted_data (encrypted blob)
      try {
        const oauthRow = db
          .prepare("SELECT COUNT(*) AS cnt FROM oauth_credentials WHERE encrypted_data IS NOT NULL")
          .get() as { cnt: number } | undefined;
        const oauthCount = oauthRow?.cnt ?? 0;
        checks.oauth_configured =
          oauthCount > 0 ? { ok: true } : { ok: false, detail: "No OAuth credentials configured (optional)" };
      } catch {
        checks.oauth_configured = { ok: false, detail: "oauth_credentials table unavailable (optional)" };
      }

      // 8. Knowledge vault check (optional)
      try {
        const vaultRow = db.prepare("SELECT COUNT(*) AS cnt FROM docs_providers WHERE enabled = 1").get() as
          | { cnt: number }
          | undefined;
        const vaultCount = vaultRow?.cnt ?? 0;
        checks.knowledge_vault_configured =
          vaultCount > 0 ? { ok: true } : { ok: false, detail: "No knowledge vault configured (optional)" };
      } catch {
        checks.knowledge_vault_configured = { ok: false, detail: "docs_providers table unavailable (optional)" };
      }

      // 9. AGENTS.md check — look for actual orchestration markers
      try {
        const agentsMdPath = path.resolve("AGENTS.md");
        const agentsMdContent = fs.readFileSync(agentsMdPath, "utf8");
        const hasMarker =
          // Both spellings: an installation configured before the rename from
          // OctoOffice still has the old marker in its AGENTS.md, and
          // reporting it as un-configured would send an operator to re-run a
          // setup that had already worked. `scripts/setup.mjs` replaces the
          // old block with the new one on its next run.
          agentsMdContent.includes("<!-- BEGIN ironcrew orchestration rules -->") ||
          agentsMdContent.includes("<!-- BEGIN octooffice orchestration rules -->") ||
          agentsMdContent.includes("INBOX_SECRET_DISCOVERY_V2");
        checks.agents_md_injected = hasMarker
          ? { ok: true }
          : { ok: false, detail: "AGENTS.md exists but missing orchestration rules — run pnpm run setup" };
      } catch {
        checks.agents_md_injected = { ok: false, detail: "AGENTS.md not found — run pnpm run setup" };
      }

      // 9. Onboarding completed flag
      let onboarding_completed = false;
      try {
        const onboardRow = db.prepare("SELECT value FROM settings WHERE key = 'onboarding_completed' LIMIT 1").get() as
          | { value?: string }
          | undefined;
        const raw = String(onboardRow?.value ?? "")
          .trim()
          .toLowerCase();
        onboarding_completed = raw === "true" || raw === "1";
      } catch {
        // settings table may not exist yet
      }

      // Derive overall status
      const { required_ok, optional_ok } = deriveOverallStatus(checks);
      const status: "ready" | "partial" | "not_configured" =
        required_ok && optional_ok ? "ready" : required_ok ? "partial" : "not_configured";

      res.json({ status, checks, onboarding_completed, required_ok, optional_ok });
    } catch (err) {
      console.error("[setup] setup_status_check_failed:", err);
      res.status(500).json({ error: "setup_status_check_failed" });
    }
  });
}
