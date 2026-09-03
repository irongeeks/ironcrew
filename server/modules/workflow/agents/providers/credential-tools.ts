import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export interface GeminiCreds {
  access_token: string;
  refresh_token: string;
  expiry_date: number;
  source: "keychain" | "file";
}

export function createCredentialTools() {
  function jsonHasKey(filePath: string, key: string): boolean {
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      const j = JSON.parse(raw);
      return j != null && typeof j === "object" && key in j && j[key] != null;
    } catch {
      return false;
    }
  }

  function fileExistsNonEmpty(filePath: string): boolean {
    try {
      const stat = fs.statSync(filePath);
      return stat.isFile() && stat.size > 2;
    } catch {
      return false;
    }
  }

  function readClaudeToken(): string | null {
    if (process.platform === "darwin") {
      try {
        const raw = execFileSync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], {
          timeout: 3000,
        })
          .toString()
          .trim();
        const j = JSON.parse(raw);
        if (j?.claudeAiOauth?.accessToken) return j.claudeAiOauth.accessToken;
      } catch {
        /* ignore */
      }
    }
    const home = os.homedir();
    try {
      const credsPath = path.join(home, ".claude", ".credentials.json");
      if (fs.existsSync(credsPath)) {
        const j = JSON.parse(fs.readFileSync(credsPath, "utf8"));
        if (j?.claudeAiOauth?.accessToken) return j.claudeAiOauth.accessToken;
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  function readCodexTokens(): { access_token: string; account_id: string } | null {
    try {
      const authPath = path.join(os.homedir(), ".codex", "auth.json");
      const j = JSON.parse(fs.readFileSync(authPath, "utf8"));
      if (j?.tokens?.access_token && j?.tokens?.account_id) {
        return { access_token: j.tokens.access_token, account_id: j.tokens.account_id };
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  // Gemini OAuth refresh credentials must come from env in public deployments.
  const GEMINI_OAUTH_CLIENT_ID = process.env.GEMINI_OAUTH_CLIENT_ID ?? process.env.OAUTH_GOOGLE_CLIENT_ID ?? "";
  const GEMINI_OAUTH_CLIENT_SECRET =
    process.env.GEMINI_OAUTH_CLIENT_SECRET ?? process.env.OAUTH_GOOGLE_CLIENT_SECRET ?? "";

  function readGeminiCredsFromKeychain(): GeminiCreds | null {
    if (process.platform !== "darwin") return null;
    try {
      const raw = execFileSync(
        "security",
        ["find-generic-password", "-s", "gemini-cli-oauth", "-a", "main-account", "-w"],
        { timeout: 3000, stdio: ["pipe", "pipe", "pipe"] },
      )
        .toString()
        .trim();
      if (!raw) return null;
      const stored = JSON.parse(raw);
      if (!stored?.token?.accessToken) return null;
      return {
        access_token: stored.token.accessToken,
        refresh_token: stored.token.refreshToken ?? "",
        expiry_date: stored.token.expiresAt ?? 0,
        source: "keychain",
      };
    } catch {
      return null;
    }
  }

  function readGeminiCredsFromFile(): GeminiCreds | null {
    try {
      const p = path.join(os.homedir(), ".gemini", "oauth_creds.json");
      const j = JSON.parse(fs.readFileSync(p, "utf8"));
      if (j?.access_token) {
        return {
          access_token: j.access_token,
          refresh_token: j.refresh_token ?? "",
          expiry_date: j.expiry_date ?? 0,
          source: "file",
        };
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  function readGeminiCreds(): GeminiCreds | null {
    return readGeminiCredsFromKeychain() ?? readGeminiCredsFromFile();
  }

  async function freshGeminiToken(): Promise<string | null> {
    const creds = readGeminiCreds();
    if (!creds) return null;
    if (creds.expiry_date > Date.now() + 300_000) return creds.access_token;
    if (!creds.refresh_token) return creds.access_token;
    if (!GEMINI_OAUTH_CLIENT_ID || !GEMINI_OAUTH_CLIENT_SECRET) return null;
    try {
      const resp = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: GEMINI_OAUTH_CLIENT_ID,
          client_secret: GEMINI_OAUTH_CLIENT_SECRET,
          refresh_token: creds.refresh_token,
          grant_type: "refresh_token",
        }),
        signal: AbortSignal.timeout(8000),
      });
      if (!resp.ok) return creds.access_token;
      const data = (await resp.json()) as { access_token?: string; expires_in?: number; refresh_token?: string };
      if (!data.access_token) return creds.access_token;
      if (creds.source === "file") {
        try {
          const p = path.join(os.homedir(), ".gemini", "oauth_creds.json");
          const raw = JSON.parse(fs.readFileSync(p, "utf8"));
          raw.access_token = data.access_token;
          if (data.refresh_token) raw.refresh_token = data.refresh_token;
          raw.expiry_date = Date.now() + (data.expires_in ?? 3600) * 1000;
          fs.writeFileSync(p, JSON.stringify(raw, null, 2), { mode: 0o600 });
        } catch {
          /* ignore write failure */
        }
      }
      return data.access_token;
    } catch {
      return creds.access_token;
    }
  }

  let geminiProjectCache: { id: string; fetchedAt: number } | null = null;
  const GEMINI_PROJECT_TTL = 300_000; // 5 minutes

  async function getGeminiProjectId(token: string): Promise<string | null> {
    const envProject = process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID;
    if (envProject) return envProject;

    try {
      const settingsPath = path.join(os.homedir(), ".gemini", "settings.json");
      const j = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      if (j?.cloudaicompanionProject) return j.cloudaicompanionProject;
    } catch {
      /* ignore */
    }

    if (geminiProjectCache && Date.now() - geminiProjectCache.fetchedAt < GEMINI_PROJECT_TTL) {
      return geminiProjectCache.id;
    }

    try {
      const resp = await fetch("https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          metadata: { ideType: "GEMINI_CLI", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" },
        }),
        signal: AbortSignal.timeout(8000),
      });
      if (!resp.ok) return null;
      const data = (await resp.json()) as { cloudaicompanionProject?: string };
      if (data.cloudaicompanionProject) {
        geminiProjectCache = { id: data.cloudaicompanionProject, fetchedAt: Date.now() };
        return geminiProjectCache.id;
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  return {
    jsonHasKey,
    fileExistsNonEmpty,
    readClaudeToken,
    readCodexTokens,
    readGeminiCredsFromKeychain,
    readGeminiCredsFromFile,
    readGeminiCreds,
    freshGeminiToken,
    getGeminiProjectId,
  };
}
