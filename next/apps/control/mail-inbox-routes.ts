import type { Express, Response } from "express";
import { z } from "zod";
import type { MutationHandler } from "./workflow-routes.ts";
import {
  mailInboxStatusSchema,
  mailInboxPolicyResultSchema,
  storedMailMessageSchema,
  mailPollResultSchema,
  mailFinanceImportResultSchema,
} from "./api-contracts/mail-inbox.ts";
import type { MailInboxService } from "./mail-inbox-service.ts";
export function registerMailInboxRoutes(
  app: Express,
  options: {
    service: MailInboxService;
    context: (res: Response) => Promise<{ companyId: string; ceoId: string }> | { companyId: string; ceoId: string };
    mutate: MutationHandler;
  },
) {
  const { service, context, mutate } = options;
  app.get("/api/v1/mail-inbox", async (_req, res) => {
    const actor = await context(res);
    res.json(
      mailInboxStatusSchema.parse({
        policies: await service.policies(actor.companyId, actor.ceoId),
        targets: await service.targets(actor.companyId, actor.ceoId),
        messages: await service.messages(actor.companyId, actor.ceoId),
      }),
    );
  });
  app.post(
    "/api/v1/mail-inbox/policies",
    mutate(async (req, res) => {
      const actor = await context(res);
      return mailInboxPolicyResultSchema.parse(await service.configure(actor.companyId, actor.ceoId, req.body));
    }),
  );
  app.put(
    "/api/v1/mail-inbox/policies/:id",
    mutate(async (req, res) => {
      const actor = await context(res);
      return mailInboxPolicyResultSchema.parse(
        await service.configure(actor.companyId, actor.ceoId, req.body, {
          id: z.uuid().parse(req.params.id),
          expectedRevision: z.coerce.number().int().positive().parse(req.header("If-Match")),
        }),
      );
    }),
  );
  app.post(
    "/api/v1/mail-inbox/policies/:id/poll",
    mutate(async (req, res) => {
      const actor = await context(res);
      return mailPollResultSchema.parse(
        await service.poll(actor.companyId, actor.ceoId, z.uuid().parse(req.params.id)),
      );
    }),
  );
  app.get("/api/v1/mail-inbox/messages/:id", async (req, res) => {
    const actor = await context(res);
    res.json(storedMailMessageSchema.parse(await service.message(actor.companyId, actor.ceoId, String(req.params.id))));
  });
  app.get("/api/v1/mail-inbox/messages/:id/blobs/:hash", async (req, res) => {
    const actor = await context(res),
      bytes = await service.blob(actor.companyId, actor.ceoId, String(req.params.id), String(req.params.hash));
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", 'attachment; filename="mail-evidence.bin"');
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    res.send(bytes);
  });
  app.post(
    "/api/v1/mail-inbox/messages/:id/finance",
    mutate(async (req, res) => {
      const actor = await context(res);
      return mailFinanceImportResultSchema.parse(
        await service.finance(actor.companyId, actor.ceoId, String(req.params.id), req.body),
      );
    }),
  );
}
