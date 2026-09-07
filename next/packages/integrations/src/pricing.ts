import { z } from "zod";
import type { AuthorizedIntegrationAction, IntegrationConnection } from "./service.ts";
import type { HttpResponse } from "./transport.ts";

/** Administrative contractual price, never supplied by a model or inferred from monthly credits. */
export const integrationPriceSchema = z
  .object({
    id: z.uuid(),
    version: z.number().int().positive(),
    toolId: z.literal("research.search"),
    currency: z.literal("USD"),
    requestUsdMicros: z.string().regex(/^[1-9][0-9]{0,17}$/),
    validFrom: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    sourceUrl: z.url().refine((value) => {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password;
    }),
  })
  .strict()
  .refine((price) => Date.parse(price.expiresAt) > Date.parse(price.validFrom), "Invalid price validity interval");
export type IntegrationPrice = z.infer<typeof integrationPriceSchema>;
export type MeteredIntegrationRequest = (input: {
  action: AuthorizedIntegrationAction;
  connection: IntegrationConnection;
  execute: () => Promise<HttpResponse>;
}) => Promise<HttpResponse>;
