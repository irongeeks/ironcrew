import type { RuntimeContext } from "../../../../types/runtime-context.ts";
import type { SkillDetail, SkillEntry } from "./types.ts";

const SKILLS_CACHE_TTL = 3600_000;
const SKILL_DETAIL_CACHE_TTL = 3600_000;

let cachedSkills: { data: SkillEntry[]; loadedAt: number } | null = null;
const skillDetailCache = new Map<string, { data: SkillDetail; loadedAt: number }>();

async function fetchSkillsFromSite(): Promise<SkillEntry[]> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    const resp = await fetch("https://skills.sh", { signal: controller.signal });
    clearTimeout(timeout);
    if (!resp.ok) return [];
    const html = await resp.text();

    const anchor = html.indexOf("initialSkills");
    if (anchor === -1) return [];
    const bracketStart = html.indexOf(":[", anchor);
    if (bracketStart === -1) return [];
    const arrStart = bracketStart + 1;

    let depth = 0;
    let arrEnd = arrStart;
    for (let i = arrStart; i < html.length; i++) {
      if (html[i] === "[") depth++;
      else if (html[i] === "]") depth--;
      if (depth === 0) {
        arrEnd = i + 1;
        break;
      }
    }

    const raw = html.slice(arrStart, arrEnd).replace(/\\"/g, '"');
    const items: Array<{ source?: string; skillId?: string; name?: string; installs?: number }> = JSON.parse(raw);

    return items.map((obj, i) => ({
      rank: i + 1,
      name: obj.name ?? obj.skillId ?? "",
      skillId: obj.skillId ?? obj.name ?? "",
      repo: obj.source ?? "",
      installs: typeof obj.installs === "number" ? obj.installs : 0,
    }));
  } catch {
    return [];
  }
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _m;
    })
    .replace(/&#([0-9]+);/g, (_m, dec: string) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _m;
    })
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ");
}

function stripHtml(input: string): string {
  return decodeHtmlEntities(
    input
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|h1|h2|h3|h4|h5|h6|li|tr|div)>/gi, "\n")
      .replace(/<li[^>]*>/gi, "• ")
      .replace(/<[^>]*>/g, ""),
  )
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function collapseWhitespace(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function extractProseContent(html: string): string {
  const strictMatch = html.match(
    /<div class="prose[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>\s*<\/div>\s*<div class=" lg:col-span-3">/i,
  );
  if (strictMatch?.[1]) return strictMatch[1];

  const proseStart = html.indexOf('<div class="prose');
  if (proseStart === -1) return "";
  const innerStart = html.indexOf(">", proseStart);
  if (innerStart === -1) return "";
  const rightColStart = html.indexOf('<div class=" lg:col-span-3">', innerStart);
  if (rightColStart === -1) return "";

  const chunk = html.slice(innerStart + 1, rightColStart);
  const trimmed = chunk.replace(/\s*<\/div>\s*$/i, "");
  return trimmed.trim();
}

async function fetchSkillDetail(source: string, skillId: string): Promise<SkillDetail | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    const url = `https://skills.sh/${source}/${skillId}`;
    const resp = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!resp.ok) return null;
    const html = await resp.text();

    const proseContent = extractProseContent(html);
    const titleMatch = proseContent.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    const title = titleMatch ? collapseWhitespace(stripHtml(titleMatch[1])) : "";

    const afterTitle = titleMatch ? proseContent.slice((titleMatch.index ?? 0) + titleMatch[0].length) : proseContent;
    const firstParagraphMatch = afterTitle.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    let description = firstParagraphMatch ? collapseWhitespace(stripHtml(firstParagraphMatch[1])) : "";

    const whenToUse: string[] = [];
    const whenSectionMatch = proseContent.match(
      /<h2[^>]*>\s*When to Use This Skill\s*<\/h2>([\s\S]*?)(?:<h2[^>]*>|$)/i,
    );
    if (whenSectionMatch) {
      const listMatch = whenSectionMatch[1].match(/<ul[^>]*>([\s\S]*?)<\/ul>/i);
      if (listMatch) {
        const liRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
        let li: RegExpExecArray | null = null;
        while ((li = liRegex.exec(listMatch[1])) !== null) {
          const item = collapseWhitespace(stripHtml(li[1]));
          if (item) whenToUse.push(item);
        }
      }
    }

    if (!description) {
      const metaDesc =
        html.match(/<meta\s+name="description"\s+content="([^"]*?)"/i) ??
        html.match(/<meta\s+content="([^"]*?)"\s+name="description"/i);
      if (metaDesc) description = collapseWhitespace(decodeHtmlEntities(metaDesc[1]));
    }

    let weeklyInstalls = "";
    const weeklyMatch = html.match(/Weekly\s+Installs[\s\S]{0,240}?>([\d,.]+[KkMm]?)<\/div>/i);
    if (weeklyMatch) weeklyInstalls = weeklyMatch[1];

    let firstSeen = "";
    const firstSeenMatch = html.match(/First\s+[Ss]een[\s\S]{0,240}?>([A-Za-z]{3}\s+\d{1,2},\s+\d{4})<\/div>/i);
    if (firstSeenMatch) firstSeen = firstSeenMatch[1];

    let installCommand = "";
    const rscCommand = html.match(/\\"command\\":\\"((?:[^"\\]|\\.)*)\\"/);
    if (rscCommand) {
      installCommand = rscCommand[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\").trim();
    }
    if (!installCommand) {
      const commandMatch = html.match(/<code[^>]*>([\s\S]*?)<\/code>/i);
      if (commandMatch && commandMatch[1].includes("npx skills add")) {
        const commandText = collapseWhitespace(stripHtml(commandMatch[1])).replace(/^\$\s*/, "");
        if (commandText) installCommand = commandText;
      }
    }
    if (!installCommand) {
      installCommand = `npx skills add https://github.com/${source} --skill ${skillId}`;
    }

    const platformMap = new Map<string, string>();
    const platforms: Array<{ name: string; installs: string }> = [];
    const platformRegex = /(claude-code|opencode|codex|gemini-cli|github-copilot|amp)[\s:]+?([\d,.]+[KkMm]?)/gi;
    let pm: RegExpExecArray | null = null;
    while ((pm = platformRegex.exec(html)) !== null) {
      if (!platformMap.has(pm[1])) platformMap.set(pm[1], pm[2]);
    }
    for (const [name, installs] of platformMap.entries()) {
      platforms.push({ name, installs });
    }

    const auditMap = new Map<string, string>();
    const audits: Array<{ name: string; status: string }> = [];
    const auditSpanRegex =
      /<span[^>]*>\s*(Gen Agent Trust Hub|Socket|Snyk)\s*<\/span>\s*<span[^>]*>\s*(Pass|Fail|Warn|Pending)\s*<\/span>/gi;
    let am: RegExpExecArray | null = null;
    while ((am = auditSpanRegex.exec(html)) !== null) {
      if (!auditMap.has(am[1])) auditMap.set(am[1], am[2]);
    }

    const auditFallbackRegex = /(Gen Agent Trust Hub|Socket|Snyk)\s*:\s*(Pass|Fail|Warn|Pending)/gi;
    while ((am = auditFallbackRegex.exec(html)) !== null) {
      if (!auditMap.has(am[1])) auditMap.set(am[1], am[2]);
    }
    for (const [name, status] of auditMap.entries()) {
      audits.push({ name, status });
    }

    return {
      title,
      description,
      whenToUse,
      weeklyInstalls,
      firstSeen,
      installCommand,
      platforms,
      audits,
    };
  } catch {
    return null;
  }
}

export function registerSkillCatalogRoutes(ctx: RuntimeContext): void {
  const { app } = ctx;

  app.get("/api/skills", async (_req, res) => {
    if (cachedSkills && Date.now() - cachedSkills.loadedAt < SKILLS_CACHE_TTL) {
      return res.json({ skills: cachedSkills.data });
    }
    const skills = await fetchSkillsFromSite();
    if (skills.length > 0) {
      cachedSkills = { data: skills, loadedAt: Date.now() };
    }
    res.json({ skills });
  });

  app.get("/api/skills/detail", async (req, res) => {
    const source = String(req.query.source ?? "");
    const skillId = String(req.query.skillId ?? "");
    if (!source || !skillId) {
      return res.status(400).json({ error: "source and skillId required" });
    }

    const cacheKey = `${source}/${skillId}`;
    const cached = skillDetailCache.get(cacheKey);
    if (cached && Date.now() - cached.loadedAt < SKILL_DETAIL_CACHE_TTL) {
      return res.json({ ok: true, detail: cached.data });
    }

    const detail = await fetchSkillDetail(source, skillId);
    if (detail) {
      skillDetailCache.set(cacheKey, { data: detail, loadedAt: Date.now() });
      if (skillDetailCache.size > 200) {
        const oldest = [...skillDetailCache.entries()].sort((a, b) => a[1].loadedAt - b[1].loadedAt);
        for (let i = 0; i < 50; i++) skillDetailCache.delete(oldest[i][0]);
      }
    }
    res.json({ ok: !!detail, detail: detail ?? null });
  });
}
