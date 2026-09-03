import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";

type NormalizeTextField = (value: unknown) => string | null;

interface CreateProjectRouteHelpersOptions {
  db: DatabaseSync;
  normalizeTextField: NormalizeTextField;
}

export function createProjectRouteHelpers({ db, normalizeTextField }: CreateProjectRouteHelpersOptions) {
  function normalizeProjectPathInput(raw: unknown): string | null {
    const value = normalizeTextField(raw);
    if (!value) return null;

    let candidate = value;
    if (candidate === "~") {
      candidate = os.homedir();
    } else if (candidate.startsWith("~/")) {
      candidate = path.join(os.homedir(), candidate.slice(2));
    } else if (candidate === "/Projects" || candidate.startsWith("/Projects/")) {
      const suffix = candidate.slice("/Projects".length).replace(/^\/+/, "");
      candidate = suffix ? path.join(os.homedir(), "Projects", suffix) : path.join(os.homedir(), "Projects");
    } else if (candidate === "/projects" || candidate.startsWith("/projects/")) {
      const suffix = candidate.slice("/projects".length).replace(/^\/+/, "");
      candidate = suffix ? path.join(os.homedir(), "projects", suffix) : path.join(os.homedir(), "projects");
    }

    const absolute = path.isAbsolute(candidate) ? candidate : path.resolve(process.cwd(), candidate);
    return path.normalize(absolute);
  }

  const PROJECT_PATH_SCOPE_CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";

  function normalizePathForScopeCompare(value: string): string {
    const normalized = path.normalize(path.resolve(value));
    return PROJECT_PATH_SCOPE_CASE_INSENSITIVE ? normalized.toLowerCase() : normalized;
  }

  function parseProjectPathAllowedRootsEnv(raw: string | undefined): string[] {
    const text = typeof raw === "string" ? raw.trim() : "";
    if (!text) return [];
    const parts = text
      .split(/[\n,;]+/)
      .map((item) => item.trim())
      .filter(Boolean);
    const out: string[] = [];
    const seen = new Set<string>();
    for (const part of parts) {
      const normalized = normalizeProjectPathInput(part);
      if (!normalized) continue;
      const key = normalizePathForScopeCompare(normalized);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(normalized);
    }
    return out;
  }

  const PROJECT_PATH_ALLOWED_ROOTS = parseProjectPathAllowedRootsEnv(process.env.PROJECT_PATH_ALLOWED_ROOTS);

  function pathInsideRoot(candidatePath: string, rootPath: string): boolean {
    const rel = path.relative(rootPath, candidatePath);
    if (!rel) return true;
    return !rel.startsWith("..") && !path.isAbsolute(rel);
  }

  function isPathInsideAllowedRoots(candidatePath: string): boolean {
    if (PROJECT_PATH_ALLOWED_ROOTS.length === 0) return true;
    const normalizedCandidate = path.normalize(path.resolve(candidatePath));
    return PROJECT_PATH_ALLOWED_ROOTS.some((root) => pathInsideRoot(normalizedCandidate, root));
  }

  function getContainingAllowedRoot(candidatePath: string): string | null {
    if (PROJECT_PATH_ALLOWED_ROOTS.length === 0) return null;
    const normalizedCandidate = path.normalize(path.resolve(candidatePath));
    const containingRoots = PROJECT_PATH_ALLOWED_ROOTS.filter((root) => pathInsideRoot(normalizedCandidate, root));
    if (containingRoots.length === 0) return null;
    containingRoots.sort((a, b) => b.length - a.length);
    return containingRoots[0];
  }

  function pickDefaultBrowseRoot(): string | null {
    if (PROJECT_PATH_ALLOWED_ROOTS.length > 0) {
      for (const root of PROJECT_PATH_ALLOWED_ROOTS) {
        try {
          if (fs.statSync(root).isDirectory()) return root;
        } catch {
          // continue
        }
      }
      return PROJECT_PATH_ALLOWED_ROOTS[0] ?? null;
    }

    const homeDir = os.homedir();
    for (const candidate of [path.join(homeDir, "Projects"), path.join(homeDir, "projects"), homeDir, process.cwd()]) {
      try {
        if (fs.statSync(candidate).isDirectory()) return candidate;
      } catch {
        // continue
      }
    }
    return process.cwd();
  }

  function findConflictingProjectByPath(
    targetPath: string,
    excludeProjectId?: string,
  ): { id: string; name: string; project_path: string } | undefined {
    if (PROJECT_PATH_SCOPE_CASE_INSENSITIVE) {
      if (excludeProjectId) {
        return db
          .prepare(
            "SELECT id, name, project_path FROM projects WHERE LOWER(project_path) = LOWER(?) AND id != ? ORDER BY COALESCE(updated_at, created_at) DESC LIMIT 1",
          )
          .get(targetPath, excludeProjectId) as { id: string; name: string; project_path: string } | undefined;
      }
      return db
        .prepare(
          "SELECT id, name, project_path FROM projects WHERE LOWER(project_path) = LOWER(?) ORDER BY COALESCE(updated_at, created_at) DESC LIMIT 1",
        )
        .get(targetPath) as { id: string; name: string; project_path: string } | undefined;
    }
    if (excludeProjectId) {
      return db
        .prepare(
          "SELECT id, name, project_path FROM projects WHERE project_path = ? AND id != ? ORDER BY COALESCE(updated_at, created_at) DESC LIMIT 1",
        )
        .get(targetPath, excludeProjectId) as { id: string; name: string; project_path: string } | undefined;
    }
    return db
      .prepare(
        "SELECT id, name, project_path FROM projects WHERE project_path = ? ORDER BY COALESCE(updated_at, created_at) DESC LIMIT 1",
      )
      .get(targetPath) as { id: string; name: string; project_path: string } | undefined;
  }

  function inspectDirectoryPath(targetPath: string): {
    exists: boolean;
    isDirectory: boolean;
    canCreate: boolean;
    nearestExistingParent: string | null;
  } {
    try {
      const stat = fs.statSync(targetPath);
      const isDirectory = stat.isDirectory();
      return {
        exists: true,
        isDirectory,
        canCreate: isDirectory,
        nearestExistingParent: isDirectory ? targetPath : path.dirname(targetPath),
      };
    } catch {
      // fall through
    }

    let probe = path.dirname(targetPath);
    let nearestExistingParent: string | null = null;
    while (probe && probe !== path.dirname(probe)) {
      try {
        if (fs.statSync(probe).isDirectory()) {
          nearestExistingParent = probe;
          break;
        }
      } catch {
        // keep walking up
      }
      probe = path.dirname(probe);
    }

    if (!nearestExistingParent) {
      nearestExistingParent = path.parse(targetPath).root || null;
    }

    let canCreate = false;
    if (nearestExistingParent) {
      try {
        fs.accessSync(nearestExistingParent, fs.constants.W_OK);
        canCreate = true;
      } catch {
        canCreate = false;
      }
    }

    return {
      exists: false,
      isDirectory: false,
      canCreate,
      nearestExistingParent,
    };
  }

  function ensureDirectoryPathExists(targetPath: string): { ok: true } | { ok: false; reason: string } {
    try {
      fs.mkdirSync(targetPath, { recursive: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: `mkdir_failed:${message}` };
    }
    try {
      if (!fs.statSync(targetPath).isDirectory()) {
        return { ok: false, reason: "not_a_directory" };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: `stat_failed:${message}` };
    }
    return { ok: true };
  }

  function collectProjectPathSuggestions(query: string, limit: number): string[] {
    const roots =
      PROJECT_PATH_ALLOWED_ROOTS.length > 0
        ? PROJECT_PATH_ALLOWED_ROOTS
        : [path.join(os.homedir(), "Projects"), path.join(os.homedir(), "projects")];
    const q = query.trim().toLowerCase();
    const out = new Set<string>();
    const seenCanonical = new Set<string>();
    const treatCaseInsensitive = process.platform === "win32" || process.platform === "darwin";
    const canonicalKeyOf = (candidate: string): { key: string; display: string } => {
      let resolved = candidate;
      try {
        resolved = fs.realpathSync(candidate);
      } catch {
        // keep raw path
      }
      const normalized = path.normalize(resolved);
      return {
        key: treatCaseInsensitive ? normalized.toLowerCase() : normalized,
        display: normalized,
      };
    };
    const addIfMatch = (candidate: string) => {
      if (out.size >= limit) return;
      const { key, display: normalized } = canonicalKeyOf(candidate);
      if (seenCanonical.has(key)) return;
      const haystack = `${path.basename(normalized)} ${normalized}`.toLowerCase();
      if (!q || haystack.includes(q)) {
        out.add(normalized);
        seenCanonical.add(key);
      }
    };

    for (const root of roots) {
      try {
        if (!fs.statSync(root).isDirectory()) continue;
      } catch {
        continue;
      }

      addIfMatch(root);
      if (out.size >= limit) break;

      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(root, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (out.size >= limit) break;
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        addIfMatch(path.join(root, entry.name));
      }
    }

    return [...out].slice(0, limit);
  }

  function findNearestExistingDirectory(targetPath: string): string | null {
    let probe = targetPath;
    while (probe && probe !== path.dirname(probe)) {
      try {
        if (fs.statSync(probe).isDirectory()) return probe;
      } catch {
        // keep walking up
      }
      probe = path.dirname(probe);
    }
    try {
      if (probe && fs.statSync(probe).isDirectory()) return probe;
    } catch {
      // ignore
    }
    return null;
  }

  function resolveInitialBrowsePath(pathQuery: string | null): string {
    const preferred = normalizeProjectPathInput(pathQuery);
    if (preferred) {
      if (!isPathInsideAllowedRoots(preferred)) {
        const fallback = pickDefaultBrowseRoot();
        return fallback || process.cwd();
      }
      const nearest = findNearestExistingDirectory(preferred);
      if (nearest) return nearest;
    }
    return pickDefaultBrowseRoot() || process.cwd();
  }

  function execFileText(
    cmd: string,
    args: string[],
    timeoutMs: number,
    windowsHide = true,
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      execFile(cmd, args, { timeout: timeoutMs, windowsHide }, (err, stdout, stderr) => {
        if (err) {
          (err as Error & { stderr?: string }).stderr = String(stderr ?? "");
          return reject(err);
        }
        resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      });
    });
  }

  // Spawn-based process execution (for GUI dialog compatibility)
  interface SpawnGuiResult {
    code: number | null;
    stdout: string;
    stderr: string;
  }
  function spawnForGui(
    cmd: string,
    args: string[],
    timeoutMs: number,
  ): Promise<SpawnGuiResult> & { pid: number | undefined } {
    let pid: number | undefined;
    const promise = new Promise<SpawnGuiResult>((resolve, reject) => {
      const child = spawn(cmd, args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: false,
      });
      pid = child.pid;
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // ignore
        }
        reject(new Error("timeout"));
      }, timeoutMs);
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    }) as Promise<SpawnGuiResult> & { pid: number | undefined };
    promise.pid = pid;
    return promise;
  }

  async function pickNativeDirectoryPathWindows(
    timeoutMs: number,
  ): Promise<{ path: string | null; cancelled: boolean; source: string }> {
    const ts = `${process.pid}-${Date.now()}`;
    const resultFile = path.join(os.tmpdir(), `claw-pick-result-${ts}.txt`);
    const escapedResultFile = resultFile.replace(/\\/g, "\\\\");

    // Shell.Application COM → no WinForms loading needed, shows dialog immediately
    // BIF_RETURNONLYFSDIRS(1) + BIF_NEWDIALOGSTYLE(64) = 65
    const psCommand = [
      "$shell = New-Object -ComObject Shell.Application;",
      "$folder = $shell.BrowseForFolder(0, 'Select project folder for OctoOffice', 65, 0);",
      `if ($folder -ne $null) { [System.IO.File]::WriteAllText('${escapedResultFile}', $folder.Self.Path) }`,
    ].join(" ");

    try {
      const { code, stderr } = await spawnForGui(
        "powershell.exe",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-STA", "-Command", psCommand],
        timeoutMs,
      );
      if (code !== 0) {
        throw new Error(`powershell exited with code ${code}: ${stderr.substring(0, 300)}`);
      }
      try {
        const value = fs.readFileSync(resultFile, "utf8").trim();
        return { path: value || null, cancelled: !value, source: "powershell" };
      } catch {
        return { path: null, cancelled: true, source: "powershell" };
      }
    } finally {
      try {
        fs.unlinkSync(resultFile);
      } catch {
        // ignore
      }
    }
  }

  async function pickNativeDirectoryPathWindowsVbs(
    timeoutMs: number,
  ): Promise<{ path: string | null; cancelled: boolean; source: string }> {
    const ts = `${process.pid}-${Date.now()}`;
    const resultFile = path.join(os.tmpdir(), `claw-pick-result-${ts}.txt`);
    const scriptFile = path.join(os.tmpdir(), `claw-pick-${ts}.vbs`);

    const vbsScript = [
      "On Error Resume Next",
      "Dim shell, folder, fso",
      'Set shell = CreateObject("Shell.Application")',
      "If Err.Number <> 0 Then WScript.Quit 1",
      'Set folder = shell.BrowseForFolder(0, "Select project folder for OctoOffice", 65, 0)',
      "If Not folder Is Nothing Then",
      '  Set fso = CreateObject("Scripting.FileSystemObject")',
      `  Set f = fso.CreateTextFile("${resultFile.replace(/\\/g, "\\\\")}", True)`,
      "  f.Write folder.Self.Path",
      "  f.Close",
      "End If",
    ].join("\r\n");

    // BrowseForFolder blocks synchronously, so a helper brings the dialog to foreground
    const activatorFile = path.join(os.tmpdir(), `claw-pick-activate-${ts}.vbs`);
    const activatorScript = [
      "WScript.Sleep 400",
      'Set sh = CreateObject("WScript.Shell")',
      // Bring the wscript process window to foreground by PID
      "sh.AppActivate CLng(WScript.Arguments(0))",
      "WScript.Sleep 300",
      "sh.AppActivate CLng(WScript.Arguments(0))",
    ].join("\r\n");

    fs.writeFileSync(scriptFile, vbsScript, "utf8");
    fs.writeFileSync(activatorFile, activatorScript, "utf8");
    try {
      // Main dialog process
      const mainPromise = spawnForGui("wscript.exe", [scriptFile], timeoutMs);
      const mainPid = mainPromise.pid;

      // Helper: bring main process (wscript) window to foreground after 400ms
      const activatorChild = spawn("wscript.exe", [activatorFile, String(mainPid ?? 0)], {
        stdio: "ignore",
        windowsHide: true,
      });

      const { code: vbsCode, stderr: vbsStderr } = await mainPromise;

      try {
        activatorChild.kill();
      } catch {
        // ignore
      }

      if (vbsCode !== 0 && vbsCode !== null) {
        throw new Error(`wscript exited with code ${vbsCode}: ${vbsStderr.substring(0, 300)}`);
      }
      try {
        const value = fs.readFileSync(resultFile, "utf8").trim();
        return { path: value || null, cancelled: !value, source: "wscript" };
      } catch {
        return { path: null, cancelled: true, source: "wscript" };
      }
    } finally {
      try {
        fs.unlinkSync(scriptFile);
      } catch {
        // ignore
      }
      try {
        fs.unlinkSync(resultFile);
      } catch {
        // ignore
      }
      try {
        fs.unlinkSync(activatorFile);
      } catch {
        // ignore
      }
    }
  }

  async function pickNativeDirectoryPath(): Promise<{ path: string | null; cancelled: boolean; source: string }> {
    const timeoutMs = 60_000;

    if (process.platform === "darwin") {
      const script =
        'try\nPOSIX path of (choose folder with prompt "Select project folder for OctoOffice")\non error number -128\n""\nend try';
      const { stdout } = await execFileText("osascript", ["-e", script], timeoutMs);
      const value = stdout.trim();
      return { path: value || null, cancelled: !value, source: "osascript" };
    }

    if (process.platform === "win32") {
      // wscript.exe + VBS → starts immediately (PowerShell is slow to start, used only as fallback)
      try {
        return await pickNativeDirectoryPathWindowsVbs(timeoutMs);
      } catch (vbsErr) {
        try {
          return await pickNativeDirectoryPathWindows(timeoutMs);
        } catch (psErr) {
          const vbsMsg = vbsErr instanceof Error ? vbsErr.message : String(vbsErr);
          const psMsg = psErr instanceof Error ? psErr.message : String(psErr);
          throw new Error(`windows_picker_failed: wscript=${vbsMsg}; powershell=${psMsg}`);
        }
      }
    }

    // Linux: zenity → kdialog fallback
    try {
      const { stdout } = await execFileText(
        "zenity",
        ["--file-selection", "--directory", "--title=Select project folder for OctoOffice"],
        timeoutMs,
      );
      const value = stdout.trim();
      return { path: value || null, cancelled: !value, source: "zenity" };
    } catch {
      try {
        const { stdout } = await execFileText(
          "kdialog",
          [
            "--getexistingdirectory",
            path.join(os.homedir(), "Projects"),
            "--title",
            "Select project folder for OctoOffice",
          ],
          timeoutMs,
        );
        const value = stdout.trim();
        return { path: value || null, cancelled: !value, source: "kdialog" };
      } catch {
        return { path: null, cancelled: false, source: "unsupported" };
      }
    }
  }

  function validateProjectAgentIds(
    raw: unknown,
  ): { agentIds: string[] } | { error: { code: string; invalidIds?: string[] } } {
    if (raw === undefined) return { agentIds: [] };
    if (!Array.isArray(raw)) {
      return { error: { code: "invalid_agent_ids_type" } };
    }
    const agentIds = [
      ...new Set(raw.filter((value): value is string => typeof value === "string" && value.trim().length > 0)),
    ];
    if (agentIds.length === 0) return { agentIds };

    const placeholders = agentIds.map(() => "?").join(",");
    const rows = db.prepare(`SELECT id FROM agents WHERE id IN (${placeholders})`).all(...agentIds) as Array<{
      id: string;
    }>;
    const existing = new Set(rows.map((row) => row.id));
    const invalidIds = agentIds.filter((id) => !existing.has(id));
    if (invalidIds.length > 0) {
      return { error: { code: "invalid_agent_ids", invalidIds } };
    }
    return { agentIds };
  }

  return {
    PROJECT_PATH_ALLOWED_ROOTS,
    normalizeProjectPathInput,
    pathInsideRoot,
    isPathInsideAllowedRoots,
    getContainingAllowedRoot,
    findConflictingProjectByPath,
    inspectDirectoryPath,
    ensureDirectoryPathExists,
    collectProjectPathSuggestions,
    resolveInitialBrowsePath,
    pickNativeDirectoryPath,
    validateProjectAgentIds,
  };
}
