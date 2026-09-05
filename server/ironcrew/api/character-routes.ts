import path from "node:path";
import type { Express, Request, Response, NextFunction } from "express";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { CHARACTER_SKINS } from "../../../src/shared/character-skins.ts";
import type { CrewAuth } from "../auth/crew-auth.ts";
import { CharacterAssetError, CharacterStore } from "../domain/character-store.ts";

export interface CharacterRoutesOptions {
  db: DatabaseSync;
  companyId: string;
  auth: CrewAuth;
  base?: string;
  assetsDir?: string;
}

/** Mount after the normal crew identity/session middleware. Private files never enter public static assets. */
export function registerCharacterRoutes(app: Express, options: CharacterRoutesOptions): CharacterStore {
  const { db, companyId, auth } = options;
  const base = options.base ?? "/api/crew";
  const store = new CharacterStore(db, options.assetsDir ?? path.resolve("data/private-assets/characters"));
  const ownerOnly = auth.requireRole("owner");
  const handle =
    (fn: (req: Request, res: Response) => unknown | Promise<unknown>) =>
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        await fn(req, res);
      } catch (error) {
        if (error instanceof CharacterAssetError) {
          res.status(error.status).json({ error: "invalid_character_asset", message: error.message });
          return;
        }
        if (error instanceof z.ZodError) {
          res
            .status(400)
            .json({ error: "invalid_character_request", message: "Ungültige Figurenauswahl oder Bilddatei." });
          return;
        }
        next(error);
      }
    };
  const id = (req: Request) => (typeof req.params.id === "string" ? req.params.id : "");
  app.get(`${base}/character-skins`, auth.requireUser, (_req, res) => {
    res.json({ skins: CHARACTER_SKINS });
  });
  app.get(
    `${base}/character-assets`,
    auth.requireUser,
    handle((_req, res) => {
      res.json({ assets: store.list(companyId) });
    }),
  );
  app.post(
    `${base}/character-assets`,
    ownerOnly,
    handle(async (req, res) => {
      const asset = await store.upload(companyId, req.body, auth.actorOf(req));
      res.status(201).json({ asset });
    }),
  );
  app.get(
    `${base}/character-assets/:id`,
    auth.requireUser,
    handle((req, res) => {
      const asset = store.read(companyId, id(req));
      res.set({
        "Content-Type": asset.contentType,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      });
      res.send(asset.buffer);
    }),
  );
  app.patch(
    `${base}/agents/:id/appearance`,
    ownerOnly,
    handle((req, res) => {
      const appearance = store.assign(companyId, id(req), req.body, auth.actorOf(req));
      res.json({ appearance });
    }),
  );
  return store;
}
