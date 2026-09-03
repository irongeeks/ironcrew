import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod/v4";
import type { RuntimeContext } from "../../../types/runtime-context.ts";
import { logger } from "../../../observability/logger.ts";

const log = logger.child({ module: "ops" });

const CreateCustomSkillSchema = z.object({
  skillName: z
    .string()
    .min(1, "skillName is required")
    .max(80)
    .regex(/^[A-Za-z0-9_-]+$/, "skillName must be alphanumeric, dash, or underscore"),
  content: z.string().min(1, "content is required").max(512_000, "content too large (max 512KB)"),
  providers: z.array(z.string()).min(1, "At least one provider is required"),
});

const CUSTOM_SKILL_NAME_RE = /^[A-Za-z0-9_-]{1,80}$/;

function parseCustomSkillName(raw: unknown): { inputName: string; canonicalName: string } | null {
  const inputName = String(raw ?? "").trim();
  if (!inputName || !CUSTOM_SKILL_NAME_RE.test(inputName)) return null;
  return { inputName, canonicalName: inputName.toLowerCase() };
}

function resolveCustomSkillDirectory(
  customSkillsDir: string,
  skillName: string,
): {
  dirName: string;
  dirPath: string;
  canonicalName: string;
} | null {
  const canonicalName = skillName.toLowerCase();
  const canonicalPath = path.join(customSkillsDir, canonicalName);
  if (fs.existsSync(canonicalPath)) {
    return { dirName: canonicalName, dirPath: canonicalPath, canonicalName };
  }
  if (!fs.existsSync(customSkillsDir)) return null;
  const entries = fs.readdirSync(customSkillsDir, { withFileTypes: true });
  const matched = entries.find((entry) => entry.isDirectory() && entry.name.toLowerCase() === canonicalName);
  if (!matched) return null;
  return { dirName: matched.name, dirPath: path.join(customSkillsDir, matched.name), canonicalName };
}

export function registerCustomSkillRoutes(
  ctx: RuntimeContext,
  deps: { normalizeSkillLearnProviders: (input: unknown) => string[] },
): void {
  const { app, logsDir, db } = ctx;
  const { normalizeSkillLearnProviders } = deps;

  app.post("/api/skills/custom", async (req, res) => {
    try {
      const parseResult = CreateCustomSkillSchema.safeParse(req.body ?? {});
      if (!parseResult.success) {
        const issues = parseResult.error.issues.map((issue) => {
          const p = issue.path.length > 0 ? issue.path.join(".") + ": " : "";
          return p + issue.message;
        });
        return res.status(400).json({ ok: false, error: "validation_failed", message: issues.join("; ") });
      }

      const { skillName: rawSkillName, content: rawContent, providers: rawProviders } = parseResult.data;
      const parsedSkillName = parseCustomSkillName(rawSkillName);
      const skillName = parsedSkillName?.inputName ?? "";
      const canonicalSkillName = parsedSkillName?.canonicalName ?? "";
      const content = rawContent.trim();
      const providers = normalizeSkillLearnProviders(rawProviders);

      if (!parsedSkillName) {
        return res.status(400).json({
          ok: false,
          error: "invalid_skill_name",
          message: "Invalid skillName format (alphanumeric, dash, underscore, max 80 chars)",
        });
      }
      if (providers.length === 0) {
        return res
          .status(400)
          .json({ ok: false, error: "providers_required", message: "At least one valid provider is required" });
      }

      const customSkillsDir = path.join(logsDir, "..", "custom-skills");
      const resolvedExisting = resolveCustomSkillDirectory(customSkillsDir, canonicalSkillName);
      const skillDir = resolvedExisting?.dirPath ?? path.join(customSkillsDir, canonicalSkillName);
      fs.mkdirSync(skillDir, { recursive: true });

      const skillFilePath = path.join(skillDir, "skills.md");
      fs.writeFileSync(skillFilePath, content, "utf-8");

      const meta = {
        skillName,
        canonicalSkillName,
        providers,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        contentLength: content.length,
      };
      fs.writeFileSync(path.join(skillDir, "meta.json"), JSON.stringify(meta, null, 2), "utf-8");

      const jobId = randomUUID();
      for (const provider of providers) {
        const histId = randomUUID();
        const now = Date.now();
        try {
          db.prepare(
            `
          INSERT INTO skill_learning_history
            (id, job_id, provider, repo, skill_id, skill_label, status, command, error, run_started_at, run_completed_at, created_at, updated_at)
          VALUES
            (?, ?, ?, ?, ?, ?, 'succeeded', ?, NULL, ?, ?, ?, ?)
        `,
          ).run(
            histId,
            jobId,
            provider,
            `custom/${canonicalSkillName}`,
            canonicalSkillName,
            skillName,
            `custom-skill upload: ${skillName}`,
            now,
            now,
            now,
            now,
          );
        } catch (dbErr) {
          log.warn({ err: dbErr, provider }, "failed to record custom skill history");
        }
      }

      res.json({
        ok: true,
        skillName,
        canonicalSkillName,
        providers,
        jobId,
      });
    } catch (err) {
      log.error({ err }, "custom skill execution failed");
      res.status(500).json({ ok: false, error: "Failed to save custom skill" });
    }
  });

  app.get("/api/skills/custom", (_req, res) => {
    try {
      const customSkillsDir = path.join(logsDir, "..", "custom-skills");
      if (!fs.existsSync(customSkillsDir)) {
        return res.json({ ok: true, skills: [] });
      }
      const entries = fs.readdirSync(customSkillsDir, { withFileTypes: true });
      const dedupedByCanonical = new Map<
        string,
        {
          skillName: string;
          providers: string[];
          createdAt: number;
          contentLength: number;
        }
      >();
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const metaPath = path.join(customSkillsDir, entry.name, "meta.json");
        if (!fs.existsSync(metaPath)) continue;
        try {
          const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
          const resolvedSkillName = String(meta.skillName ?? entry.name).trim();
          const canonicalSkillName = String(meta.canonicalSkillName ?? resolvedSkillName)
            .trim()
            .toLowerCase();
          if (!canonicalSkillName) continue;
          const row = {
            skillName: meta.skillName ?? entry.name,
            providers: meta.providers ?? [],
            createdAt: meta.createdAt ?? 0,
            contentLength: meta.contentLength ?? 0,
          };
          const prev = dedupedByCanonical.get(canonicalSkillName);
          if (!prev || row.createdAt >= prev.createdAt) {
            dedupedByCanonical.set(canonicalSkillName, row);
          }
        } catch {
          // malformed meta.json ignored
        }
      }
      const skills = Array.from(dedupedByCanonical.values());
      skills.sort((a, b) => b.createdAt - a.createdAt);
      res.json({ ok: true, skills });
    } catch (err) {
      log.error({ err }, "custom skill list failed");
      res.status(500).json({ ok: false, error: "Failed to list custom skills" });
    }
  });

  app.delete("/api/skills/custom/:skillName", (req, res) => {
    try {
      const parsedSkillName = parseCustomSkillName(req.params.skillName);
      if (!parsedSkillName) {
        return res.status(400).json({ ok: false, error: "invalid skillName" });
      }
      const customSkillsDir = path.join(logsDir, "..", "custom-skills");
      const resolvedSkill = resolveCustomSkillDirectory(customSkillsDir, parsedSkillName.canonicalName);
      if (!resolvedSkill) {
        return res.status(404).json({ ok: false, error: "skill_not_found" });
      }
      fs.rmSync(resolvedSkill.dirPath, { recursive: true, force: true });

      db.prepare(`DELETE FROM skill_learning_history WHERE lower(repo) = lower(?)`).run(
        `custom/${resolvedSkill.canonicalName}`,
      );

      res.json({ ok: true, skillName: parsedSkillName.inputName });
    } catch (err) {
      log.error({ err }, "custom skill delete failed");
      res.status(500).json({ ok: false, error: "Failed to delete custom skill" });
    }
  });
}
