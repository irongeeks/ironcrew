import { execFile } from "node:child_process";
import { mkdir, lstat, realpath, readFile, writeFile, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import type { ActionRequest } from "../../domain/workflows/actions.ts";
import type { ToolAction, Scope } from "../../contracts/src/index.ts";
import { IntegrationError, redact } from "./transport.ts";
import type { SecretRef, SecretResolver } from "./secrets.ts";
export interface GitActionPort {
  perform(
    request: ActionRequest,
    execute: (action: ToolAction) => Promise<unknown>,
  ): Promise<{ state: string; id: string; data?: unknown }>;
}
export interface GitConnection {
  id: string;
  scope: Scope;
  repositoryPath: string;
  workspaceRoot: string;
  gitExecutable: string;
  sourceBranch: string;
  remoteName: string;
  remoteUrl: string;
  remoteBranch: string;
  authorName: string;
  authorEmail: string;
  allowLocalRemote?: boolean;
  credential?: { username: string; secretRef: SecretRef };
}
const commitSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const relative = z
  .string()
  .min(1)
  .max(1500)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      !value.includes(":") &&
      value
        .split("/")
        .every((part) => Boolean(part) && part !== "." && part !== ".." && part.toLowerCase() !== ".git") &&
      ![...value].some((char) => char.charCodeAt(0) < 32),
  );
export const gitStageSchema = z
  .object({
    expectedHead: commitSchema,
    message: z.string().min(1).max(1000),
    changes: z
      .array(
        z
          .object({
            path: relative,
            content: z
              .string()
              .max(2 * 1024 * 1024)
              .nullable(),
            expectedSha256: z
              .string()
              .regex(/^[a-f0-9]{64}$/)
              .nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
export const gitPushSchema = z.object({ commit: commitSchema, expectedRemoteHead: commitSchema.nullable() }).strict();
export const gitCapabilities = [
  { id: "git.stage", effect: "workspace_write", inputSchema: gitStageSchema, retryPolicy: "reconcile_first" },
  { id: "git.push", effect: "external_change", inputSchema: gitPushSchema, retryPolicy: "reconcile_first" },
] as const;
type Request = Omit<ActionRequest, "scope" | "targetId" | "toolId" | "effect" | "args" | "requireApproval">;
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
/** Own refs/heads/ironcrew/<target-id> branch and detached worktrees; never changes the user's checked-out branch. */
export class GitConnector {
  private readonly config: GitConnection;
  private readonly actions: GitActionPort;
  private readonly secrets?: SecretResolver;
  constructor(config: GitConnection, actions: GitActionPort, secrets?: SecretResolver) {
    for (const value of [config.repositoryPath, config.workspaceRoot, config.gitExecutable])
      if (!path.isAbsolute(value))
        throw new IntegrationError("configuration", "Git benötigt explizite absolute Administrationspfade.");
    for (const value of [config.sourceBranch, config.remoteBranch])
      if (
        !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) ||
        value.includes("..") ||
        value.includes("//") ||
        value.endsWith("/") ||
        value.endsWith(".")
      )
        throw new IntegrationError("configuration", "Git-Branch ist ungültig.");
    if (!/^[A-Za-z0-9_-]+$/.test(config.remoteName) || !z.uuid().safeParse(config.id).success)
      throw new IntegrationError("configuration", "Git-Ziel oder Remote-Name ist ungültig.");
    if (!config.authorName.trim() || !z.email().safeParse(config.authorEmail).success)
      throw new IntegrationError("configuration", "Git-Autor benötigt Name und E-Mail.");
    if (!config.remoteUrl.startsWith("https://") && !(config.allowLocalRemote && path.isAbsolute(config.remoteUrl)))
      throw new IntegrationError(
        "configuration",
        "Git-Remote muss HTTPS oder ein explizit erlaubtes lokales Testziel sein.",
      );
    if (config.remoteUrl.startsWith("https://")) {
      const url = new URL(config.remoteUrl);
      if (url.username || url.password || url.hash || url.search)
        throw new IntegrationError("configuration", "Git-Remote darf keine eingebetteten Zugangsdaten enthalten.");
    }
    this.config = structuredClone(config);
    this.actions = actions;
    this.secrets = secrets;
  }
  private async root(): Promise<string> {
    const root = await realpath(this.config.repositoryPath);
    if (root !== path.resolve(this.config.repositoryPath) || (await lstat(root)).isSymbolicLink())
      throw new IntegrationError("configuration", "Git-Repositorypfad muss kanonisch sein.");
    await mkdir(this.config.workspaceRoot, { recursive: true, mode: 0o700 });
    const workspaces = await realpath(this.config.workspaceRoot);
    if (workspaces !== path.resolve(this.config.workspaceRoot))
      throw new IntegrationError("configuration", "Git-Workspacepfad muss kanonisch sein.");
    const local = await this.command(["config", "--local", "--list"], root);
    if (
      /(?:^|\n)(?:filter\.|include\.|includeif\.|credential\.|http\.|url\.|core\.(?:fsmonitor|sshcommand)=|diff\..*\.command=|remote\..*\.(?:pushurl|uploadpack|receivepack|proxy)=)/i.test(
        local,
      )
    )
      throw new IntegrationError(
        "configuration",
        "Repository besitzt nicht zugelassene externe Programme, Zugangsdatenkonfiguration oder Remote-Umleitungen.",
      );
    if ((await this.command(["rev-parse", "--show-toplevel"], root)) !== root)
      throw new IntegrationError(
        "configuration",
        "Git-Repositorypfad muss exakt der konfigurierte Repository-Root sein.",
      );
    return root;
  }
  private command(args: string[], cwd: string, environment: NodeJS.ProcessEnv = {}, writing = false): Promise<string> {
    const hooks = path.join(this.config.workspaceRoot, ".disabled-hooks");
    return new Promise((resolve, reject) =>
      execFile(
        this.config.gitExecutable,
        [
          "--no-pager",
          "-c",
          `core.hooksPath=${hooks}`,
          "-c",
          "core.fsmonitor=false",
          "-c",
          "commit.gpgsign=false",
          "-c",
          "core.autocrlf=false",
          "-c",
          "credential.helper=",
          "-c",
          "http.followRedirects=false",
          "-c",
          "protocol.ext.allow=never",
          "-c",
          `protocol.file.allow=${this.config.allowLocalRemote ? "always" : "never"}`,
          ...args,
        ],
        {
          cwd,
          env: {
            PATH:
              path.dirname(this.config.gitExecutable) +
              path.delimiter +
              (process.platform === "win32" ? "C:\\Windows\\System32" : "/usr/bin:/bin"),
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
            GIT_TERMINAL_PROMPT: "0",
            GIT_AUTHOR_NAME: this.config.authorName,
            GIT_AUTHOR_EMAIL: this.config.authorEmail,
            GIT_COMMITTER_NAME: this.config.authorName,
            GIT_COMMITTER_EMAIL: this.config.authorEmail,
            ...environment,
          },
          timeout: writing ? 60000 : 30000,
          maxBuffer: 4 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          if (!error) {
            resolve(stdout.trim());
            return;
          }
          const conflict = /stale info|non-fast-forward|cannot lock ref|is at [a-f0-9]+ but expected|fetch first/i.test(
            stderr,
          );
          reject(
            new IntegrationError(
              conflict ? "conflict" : "transport",
              conflict
                ? "Git-Zielversion hat sich geändert."
                : "Git-Operation fehlgeschlagen; Diagnose und Wirkung prüfen.",
              writing && !conflict ? "effect_unknown" : "failed",
            ),
          );
        },
      ),
    );
  }
  private get ref() {
    return `refs/heads/ironcrew/${this.config.id}`;
  }
  async version(): Promise<{ commit: string; branch: string }> {
    const root = await this.root();
    const exists = await this.command(["for-each-ref", "--format=%(objectname)", this.ref], root);
    return {
      commit: exists || (await this.command(["rev-parse", "--verify", `refs/heads/${this.config.sourceBranch}`], root)),
      branch: this.ref,
    };
  }
  async stage(request: Request, input: unknown) {
    const args = gitStageSchema.parse(input);
    if (new Set(args.changes.map((change) => change.path.toLowerCase())).size !== args.changes.length)
      throw new IntegrationError("validation", "Dateiänderungen enthalten doppelte Pfade.");
    if (args.changes.reduce((sum, change) => sum + Buffer.byteLength(change.content ?? ""), 0) > 10 * 1024 * 1024)
      throw new IntegrationError("validation", "Änderungspaket überschreitet 10 MiB.");
    return this.actions.perform(
      {
        ...request,
        scope: this.config.scope,
        targetId: this.config.id,
        toolId: "git.stage",
        effect: "workspace_write",
        args,
      },
      async (action) => {
        const root = await this.root();
        const ownPrior = await this.command(["for-each-ref", "--format=%(objectname)", this.ref], root);
        const currentCommit =
          ownPrior || (await this.command(["rev-parse", "--verify", `refs/heads/${this.config.sourceBranch}`], root));
        if (currentCommit !== args.expectedHead)
          throw new IntegrationError("conflict", "Git-Basisversion hat sich geändert.");
        if (!z.uuid().safeParse(action.id).success) throw new IntegrationError("validation", "Action-ID ist ungültig.");
        const workspace = path.join(this.config.workspaceRoot, action.id);
        await this.command(["worktree", "add", "--detach", workspace, args.expectedHead], root, {}, true);
        // All hashes are validated before any patch write. Failed fixtures stay isolated for evidence.
        for (const change of args.changes) {
          const target = await this.resolveFile(workspace, change.path);
          let prior: Buffer | null = null;
          try {
            prior = await readFile(target);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          if ((prior ? hash(prior) : null) !== change.expectedSha256)
            throw new IntegrationError("conflict", "Datei stimmt nicht mit dem erwarteten Hash überein.");
        }
        for (const change of args.changes) {
          const target = await this.resolveFile(workspace, change.path);
          if (change.content === null) await unlink(target);
          else {
            await mkdir(path.dirname(target), { recursive: true });
            await writeFile(target, change.content, { mode: 0o600 });
          }
        }
        await this.command(["add", "--", ...args.changes.map((change) => change.path)], workspace, {}, true);
        const diff = await this.command(["diff", "--cached", "--no-ext-diff", "--no-textconv", "--stat"], workspace);
        if (!diff) throw new IntegrationError("validation", "Änderung enthält keinen Git-Diff.");
        await this.command(["commit", "-m", args.message], workspace, {}, true);
        const commit = await this.command(["rev-parse", "HEAD"], workspace);
        await this.command(["update-ref", this.ref, commit, ownPrior || "0".repeat(commit.length)], root, {}, true);
        return {
          observedAt: new Date().toISOString(),
          effectStatus: "succeeded",
          commit,
          parent: args.expectedHead,
          workspace,
          branch: this.ref,
          diff,
          files: args.changes.map((change) => ({
            path: change.path,
            sha256: change.content === null ? null : hash(change.content),
          })),
          evidenceRefs: [],
        };
      },
    );
  }
  private async resolveFile(root: string, relative: string): Promise<string> {
    let current = root;
    for (const part of relative.split("/")) {
      current = path.join(current, part);
      try {
        if ((await lstat(current)).isSymbolicLink())
          throw new IntegrationError("authorization", "Symlink im Git-Dateipfad ist gesperrt.");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return current;
  }
  async push(request: Request, input: unknown) {
    const args = gitPushSchema.parse(input);
    return this.actions.perform(
      {
        ...request,
        scope: this.config.scope,
        targetId: this.config.id,
        toolId: "git.push",
        effect: "external_change",
        args,
        requireApproval: true,
      },
      async () => {
        const root = await this.root();
        const configured = await this.command(["remote", "get-url", "--push", this.config.remoteName], root);
        if (configured !== this.config.remoteUrl)
          throw new IntegrationError("authorization", "Git-Remote stimmt nicht mit dem freigegebenen Ziel überein.");
        const version = await this.version();
        if (version.commit !== args.commit)
          throw new IntegrationError(
            "conflict",
            "Nur die aktuelle geprüfte lokale Artefaktversion darf übertragen werden.",
          );
        const secret = this.config.credential
          ? await this.secrets?.resolve(this.config.credential.secretRef, "Authorized Git push")
          : undefined;
        if (this.config.credential && !secret)
          throw new IntegrationError("configuration", "Git-Credential ist nicht verfügbar.");
        const encoded = secret
          ? Buffer.from(`${this.config.credential!.username}:${secret}`).toString("base64")
          : undefined;
        const environment: NodeJS.ProcessEnv = encoded
          ? {
              GIT_CONFIG_COUNT: "1",
              GIT_CONFIG_KEY_0: `http.${this.config.remoteUrl}.extraHeader`,
              GIT_CONFIG_VALUE_0: `Authorization: Basic ${encoded}`,
            }
          : {};
        const remoteRef = `refs/heads/${this.config.remoteBranch}`;
        const before = await this.command(
          ["ls-remote", "--heads", this.config.remoteName, remoteRef],
          root,
          environment,
        );
        const observed = before.split(/\s/)[0] || null;
        if (observed !== args.expectedRemoteHead)
          throw new IntegrationError("conflict", "Remote-Branch hat eine neue Version.");
        if (args.expectedRemoteHead)
          await this.command(["merge-base", "--is-ancestor", args.expectedRemoteHead, args.commit], root);
        await this.command(
          [
            "push",
            "--porcelain",
            `--force-with-lease=${remoteRef}:${args.expectedRemoteHead ?? ""}`,
            this.config.remoteName,
            `${args.commit}:${remoteRef}`,
          ],
          root,
          environment,
          true,
        );
        let after: string;
        try {
          after = await this.command(["ls-remote", "--heads", this.config.remoteName, remoteRef], root, environment);
        } catch {
          throw new IntegrationError(
            "transport",
            "Git-Push konnte nicht abschließend abgeglichen werden.",
            "effect_unknown",
          );
        }
        if (after.split(/\s/)[0] !== args.commit)
          throw new IntegrationError("conflict", "Git-Zielzustand nach Push ist unklar.", "effect_unknown");
        return redact(
          {
            observedAt: new Date().toISOString(),
            effectStatus: "succeeded",
            externalId: `${this.config.remoteUrl}#${args.commit}`,
            commit: args.commit,
            remoteBranch: this.config.remoteBranch,
            evidenceRefs: [],
          },
          [secret ?? "", encoded ?? ""],
        );
      },
    );
  }
}
