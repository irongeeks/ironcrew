import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Express, Response } from "express";
import type { Scope } from "../../packages/contracts/src/index.ts";
import { scopeSchema } from "../../packages/contracts/src/index.ts";
import type { Repository } from "../../packages/persistence/src/index.ts";
import { DomainError } from "../../packages/domain/src/index.ts";
import type { MutationHandler } from "./workflow-routes.ts";
export const entityDetailsSchema = z
  .object({ name: z.string().trim().min(1).max(200), description: z.string().trim().max(4000).default("") })
  .strict();
export const customerInputSchema = entityDetailsSchema.extend({ areaId: z.uuid() }).strict();
export const projectInputSchema = customerInputSchema.extend({ customerId: z.uuid().optional() }).strict();
export const entitySchema = entityDetailsSchema
  .extend({ id: z.uuid(), scope: scopeSchema, createdAt: z.iso.datetime(), revision: z.number().int().positive() })
  .strict();
export function registerEntityRoutes(
  app: Express,
  options: { repo: Repository; context: (res: Response) => Scope; mutate: MutationHandler },
) {
  const { repo, context, mutate } = options;
  app.get("/api/v1/customers", async (_req, res) => {
    const docs = await repo.listCompanyDocuments<Record<string, unknown>>(context(res).companyId, "customer");
    res.json({
      items: docs.map((d) => entitySchema.parse({ ...d.data, scope: d.scope, revision: d.revision })),
      nextCursor: null,
    });
  });
  for (const [kind, plural, schema] of [
    ["customer", "customers", customerInputSchema],
    ["project", "projects", projectInputSchema],
  ] as const) {
    app.post(
      `/api/v1/${plural}`,
      mutate(async (req, res) => {
        const input = schema.parse(req.body),
          companyId = context(res).companyId;
        const customerId = "customerId" in input && typeof input.customerId === "string" ? input.customerId : undefined;
        const scope = { companyId, areaId: input.areaId, ...(customerId ? { customerId } : {}) };
        const id = randomUUID(),
          data = { id, name: input.name, description: input.description, scope, createdAt: new Date().toISOString() };
        const record = await repo.putDocument(scope, kind, id, data, { expectedRevision: 0 });
        return entitySchema.parse({ ...data, revision: record.revision });
      }),
    );
    app.patch(
      `/api/v1/${plural}/:id`,
      mutate(async (req, res) => {
        const id = z.uuid().parse(req.params.id),
          input = entityDetailsSchema.parse(req.body);
        const doc = (await repo.listCompanyDocuments<Record<string, unknown>>(context(res).companyId, kind)).find(
          (d) => d.id === id,
        );
        if (!doc) throw new DomainError("entity_not_found", "entity_not_found", 404);
        const revision = z.coerce.number().int().positive().parse(req.header("If-Match"));
        const result = await repo.putDocument(
          doc.scope,
          kind,
          id,
          { ...doc.data, ...input },
          { expectedRevision: revision },
        );
        return entitySchema.parse({ ...(result.data as object), scope: result.scope, revision: result.revision });
      }),
    );
  }
}
