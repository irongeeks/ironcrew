import { z } from "zod";
const id = z.string().min(1).max(4096),
  text = z.string(),
  hash = z.string().regex(/^[a-f0-9]{64}$/);
const jsonObject = z.record(z.string(), z.json());
const reference = z.object({ id: z.union([id, z.number()]), objectName: z.string() }).passthrough();
const base = z
  .object({
    observedAt: z.iso.datetime(),
    effectStatus: z.enum(["succeeded", "accepted"]),
    externalId: id.optional(),
    evidenceRefs: z.array(id).max(1000),
  })
  .strict();
/** The normalized result contract is public registry metadata and is enforced before evidence is returned. */
export function integrationOutputSchema(toolId: string): z.ZodType {
  let data: z.ZodType;
  switch (toolId) {
    case "research.search":
      data = z.object({
        sources: z
          .array(
            z.object({
              url: z.url(),
              title: text,
              excerpt: text,
              publishedAt: text.optional(),
              observedAt: z.iso.datetime(),
            }),
          )
          .max(20),
        query: text,
      });
      break;
    case "research.fetch":
      data = z.object({ url: z.url(), content: text, mediaType: text });
      break;
    case "nextcloud.read":
    case "nextcloud.list":
      data = z.object({ content: text, etag: text.optional(), sha256: hash });
      break;
    case "nextcloud.write":
    case "nextcloud.mkdir":
    case "nextcloud.move":
      data = z.object({
        content: z.object({ status: z.number().int().min(200).max(299), etag: text.optional() }),
        etag: text.optional(),
        sha256: hash,
      });
      break;
    case "gdrive.read":
    case "gdrive.create":
    case "discord.send":
      data = z.object({ id, version: text.optional(), name: text.optional() }).passthrough();
      break;
    case "gdrive.download":
      data = z.object({
        fileId: id,
        version: id,
        mediaType: text,
        bytes: z.number().int().min(0).max(1048576),
        sha256: hash,
        contentBase64: z.string().max(1398104),
      });
      break;
    case "gdrive.revisions.read":
      data = z.object({
        items: z
          .array(
            z.object({
              id,
              mimeType: text.optional(),
              modifiedTime: text.optional(),
              keepForever: z.boolean().optional(),
              size: text.optional(),
              md5Checksum: text.optional(),
            }),
          )
          .max(100),
        nextCursor: text.nullable(),
        historyCompleteness: z.literal("provider_retained_only"),
      });
      break;
    case "gdocs.read":
      data = z.object({
        documentId: id,
        title: text,
        revisionId: id,
        tabs: z.array(jsonObject).optional(),
        body: jsonObject.optional(),
      });
      break;
    case "gdocs.create":
      data = z
        .object({
          id,
          mimeType: z.literal("application/vnd.google-apps.document"),
          contentSha256: hash,
          format: z.literal("native_google_document"),
        })
        .passthrough();
      break;
    case "gdocs.append":
    case "gdocs.replace":
      data = z.object({ documentId: id, revisionId: id });
      break;
    case "gsheets.read":
      data = z.object({
        spreadsheetId: id,
        range: text,
        values: z.array(z.array(z.union([text, z.number(), z.boolean(), z.null()]))),
        contentSha256: hash,
        formulaHandling: z.literal("materialized_values"),
      });
      break;
    case "gsheets.create":
    case "gsheets.version.create":
      data = z
        .object({ spreadsheetId: id, formulaHandling: z.enum(["literal_values", "materialized_values"]) })
        .passthrough();
      break;
    case "gslides.create":
      data = z.object({ presentationId: id, title: text.optional(), empty: z.literal(true) });
      break;
    case "gslides.read":
      data = z.object({
        presentationId: id,
        revisionId: id,
        title: text.optional(),
        slides: z.array(jsonObject).optional(),
      });
      break;
    case "gslides.text.replace":
      data = z.object({ presentationId: id, revisionId: id });
      break;
    case "sevdesk.voucher.stage":
      data = z.object({ voucher: reference }).passthrough();
      break;
    case "sevdesk.voucher.book":
    case "sevdesk.reminder.create":
    case "sevdesk.reminder.send":
      data = reference;
      break;
    case "sevdesk.invoices.read":
    case "sevdesk.vouchers.read":
    case "sevdesk.transactions.read":
    case "sevdesk.invoice.read":
    case "sevdesk.voucher.upload":
      data = z.object({ objects: z.union([jsonObject, z.array(jsonObject)]) }).passthrough();
      break;
    case "proxmox.guest.action":
      data = z.object({ data: z.string().startsWith("UPID:") }).passthrough();
      break;
    case "proxmox.nodes.read":
    case "proxmox.guests.read":
      data = z.object({ data: z.array(jsonObject) }).passthrough();
      break;
    case "proxmox.task.read":
      data = z.object({ data: jsonObject }).passthrough();
      break;
    case "graph.users.read":
    case "graph.licenses.read":
    case "graph.health.read":
      data = z.object({ value: z.array(jsonObject) }).passthrough();
      break;
    case "graph.mail.send":
      data = z.object({ accepted: z.literal(true), delivered: z.literal(false) });
      break;
    case "graph.user.licenses":
      data = jsonObject;
      break;
    case "tactical.agents.read":
    case "tactical.alerts.read":
      data = z.array(jsonObject);
      break;
    case "tactical.script.run":
      data = z.json();
      break;
    case "telegram.send":
      data = z
        .object({
          ok: z.literal(true),
          result: z.object({ message_id: z.number(), chat: z.object({ id: z.number() }).passthrough() }).passthrough(),
        })
        .passthrough();
      break;
    default:
      throw Error(`Missing normalized result contract for ${toolId}`);
  }
  return base.extend({ data });
}
