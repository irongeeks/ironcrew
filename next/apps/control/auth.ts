import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import path from "node:path";
import argon2 from "argon2";
import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { digest } from "../../packages/tools/workspace.ts";
import { DomainError } from "../../packages/domain/src/index.ts";
import { shaUuid } from "../../packages/runtime/src/engine.ts";
import type { Repository } from "../../packages/persistence/src/index.ts";
import type { Scope } from "../../packages/contracts/src/index.ts";
export const passwordSchema = z.string().min(12).max(1024);
export const hashPassword = (password: string) =>
  argon2.hash(password, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 });
export async function issueSetupToken(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("base64url");
  await writeFile(
    path.join(directory, "setup-token.json"),
    JSON.stringify({ hash: digest(token), expiresAt: Date.now() + 900_000 }),
    { mode: 0o600 },
  );
  return token;
}
export async function verifySetupToken(directory: string, token: string) {
  try {
    const data = JSON.parse(await readFile(path.join(directory, "setup-token.json"), "utf8")) as {
      hash: string;
      expiresAt: number;
    };
    if (data.expiresAt < Date.now() || !equal(digest(token), data.hash)) throw new Error();
  } catch {
    throw new DomainError("setup_token_invalid", "setup_token_invalid", 401);
  }
}
export async function consumeSetupToken(directory: string) {
  await rename(path.join(directory, "setup-token.json"), path.join(directory, "setup-token.used.json"));
}
export const equal = (a: string, b: string) => {
  const aa = Buffer.from(a),
    bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
};
type Session = { hash: string; csrf: string; expiresAt: number; revoked: boolean };
export type AuthContext = { scope: Scope; csrf: string; sessionId: string };
export function cookie(req: Request) {
  return /(?:^|;\s*)ironcrew_session=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
}
export async function defaultScope(repo: Repository): Promise<Scope> {
  const setup = await repo.setupState();
  if (!setup) throw new DomainError("setup_required", "setup_required", 401);
  return { companyId: setup.company.id, areaId: setup.areas.find((a) => a.visibility === "company")!.id };
}
export async function sessionContext(repo: Repository, req: Request): Promise<AuthContext | null> {
  const token = cookie(req);
  if (!token) return null;
  const scope = await defaultScope(repo);
  const sessionId = shaUuid(token);
  const doc = await repo.getDocument<Session>(scope, "session", sessionId);
  if (!doc || doc.data.revoked || doc.data.expiresAt < Date.now() || !equal(doc.data.hash, digest(token))) return null;
  return { scope, csrf: doc.data.csrf, sessionId };
}
export async function createSession(repo: Repository, res: Response, secure: boolean) {
  const scope = await defaultScope(repo);
  const token = randomBytes(32).toString("base64url"),
    csrf = randomBytes(24).toString("base64url");
  await repo.putDocument(scope, "session", shaUuid(token), {
    hash: digest(token),
    csrf,
    expiresAt: Date.now() + 12 * 3600_000,
    revoked: false,
  });
  res.cookie("ironcrew_session", token, {
    httpOnly: true,
    sameSite: "strict",
    secure,
    path: "/",
    maxAge: 12 * 3600_000,
  });
  return csrf;
}
export function authMiddleware(repo: Repository, publicOrigin: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const context = await sessionContext(repo, req);
      if (!context) throw new DomainError("unauthorized", "unauthorized", 401);
      res.locals.auth = context;
      if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
        if (!equal(req.header("X-CSRF-Token") ?? "", context.csrf))
          throw new DomainError("csrf_invalid", "csrf_invalid", 403);
        const origin = req.header("Origin");
        if (origin && origin !== publicOrigin) throw new DomainError("origin_denied", "origin_denied", 403);
      }
      next();
    } catch (e) {
      next(e);
    }
  };
}
export async function login(repo: Repository, password: string) {
  const identity = await repo.getIdentity();
  if (!identity || !(await argon2.verify(identity.passwordHash, password)))
    throw new DomainError("invalid_credentials", "invalid_credentials", 401);
}
