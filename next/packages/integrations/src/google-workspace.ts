import { integrationOutputSchema } from "./result-contracts.ts";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { IntegrationError, checkResponse, type HttpTransport } from "./transport.ts";
import type {
  IntegrationCapability,
  IntegrationConnection,
  IntegrationResult,
  AuthorizedIntegrationAction,
} from "./service.ts";
const id = z
    .string()
    .min(1)
    .max(300)
    .regex(/^[A-Za-z0-9_-]+$/),
  revision = z.string().min(1).max(1000),
  hash = z.string().regex(/^[a-f0-9]{64}$/),
  title = z.string().min(1).max(200),
  text = z.string().max(200000);
const bound = { targetConfigSha256: hash },
  cell = z.union([z.string().max(10000), z.number().finite(), z.boolean(), z.null()]);
const rows = z
  .array(z.array(cell).max(50))
  .max(500)
  .refine((value) => Buffer.byteLength(JSON.stringify(value)) <= 1024 * 1024, "Tabellenwerte überschreiten 1MiB.");
const rectangle = {
  spreadsheetId: id,
  sheetTitle: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[^\r\n]+$/),
  startRow: z.number().int().min(1).max(1000000),
  rowCount: z.number().int().min(1).max(500),
  startColumn: z.number().int().min(1).max(1000),
  columnCount: z.number().int().min(1).max(50),
};
const docsEdit = { ...bound, documentId: id, requiredRevisionId: revision, tabId: id };
const capability = (
  name: string,
  effect: IntegrationCapability["effect"],
  inputSchema: z.ZodType,
  reconciliation: string,
): IntegrationCapability => ({
  id: name,
  outputSchema: integrationOutputSchema(name),
  provider: "gdrive",
  effect,
  inputSchema,
  requiresApproval: effect !== "read",
  retryPolicy: effect === "read" ? "safe" : "reconcile_first",
  reconciliation,
});
export const googleWorkspaceCapabilities: IntegrationCapability[] = [
  capability(
    "gdocs.create",
    "external_draft",
    z.object({ ...bound, folderId: id, title, text: text.min(1) }).strict(),
    "Create a new native Google Doc from plain text in the approved folder. Never retry an unconfirmed creation; inspect Drive appProperties. No shared permissions are added.",
  ),
  capability(
    "gdocs.read",
    "read",
    z.object({ ...bound, documentId: id }).strict(),
    "Read native document tabs and its current revision.",
  ),
  capability(
    "gdocs.append",
    "external_change",
    z.object({ ...docsEdit, text: text.min(1) }).strict(),
    "Atomic native writeControl.requiredRevisionId; only append in the selected document tab.",
  ),
  capability(
    "gdocs.replace",
    "external_change",
    z
      .object({
        ...docsEdit,
        startIndex: z.number().int().min(1).max(1000000),
        endIndex: z.number().int().min(2).max(1000001),
        text,
      })
      .strict()
      .refine((v) => v.endIndex > v.startIndex),
    "Replace one explicit UTF-16 range under exact requiredRevisionId. No arbitrary batch requests.",
  ),
  capability(
    "gsheets.read",
    "read",
    z.object({ ...bound, ...rectangle }).strict(),
    "Read a bounded rectangle of unformatted values. The content hash identifies this snapshot, not an atomic Sheets write revision.",
  ),
  capability(
    "gsheets.create",
    "external_draft",
    z.object({ ...bound, title, sheetTitle: title, rows: rows.min(1) }).strict(),
    "Create one new native spreadsheet in the authorized account root (resource create:spreadsheets). Literal values only; no formulas, URLs or sharing changes.",
  ),
  capability(
    "gsheets.version.create",
    "external_draft",
    z
      .object({
        ...bound,
        ...rectangle,
        title,
        newSheetTitle: title,
        expectedContentSha256: hash,
        edits: z
          .array(
            z
              .object({ row: z.number().int().min(0).max(499), column: z.number().int().min(0).max(49), value: cell })
              .strict(),
          )
          .min(1)
          .max(100),
      })
      .strict(),
    "Compare approved source rectangle hash, apply explicit cell edits to a NEW spreadsheet snapshot. Source remains unchanged because Sheets has no native requiredRevisionId write guard.",
  ),
  capability(
    "gslides.read",
    "read",
    z.object({ ...bound, presentationId: id }).strict(),
    "Read presentation revision and slide object IDs.",
  ),
  capability(
    "gslides.create",
    "external_draft",
    z.object({ ...bound, title }).strict(),
    "Create an empty native presentation in authorized account root (resource create:presentations). Adding content is a separate approved action.",
  ),
  capability(
    "gslides.text.replace",
    "external_change",
    z.object({ ...bound, presentationId: id, requiredRevisionId: revision, objectId: id, text: text.min(1) }).strict(),
    "Replace text of one explicit existing slide object with atomic requiredRevisionId. No arbitrary batch or object creation.",
  ),
];
export function googleConfigurationSha256(value: unknown): string {
  const canonical = (v: unknown): string =>
    v === null || typeof v !== "object"
      ? JSON.stringify(v)
      : Array.isArray(v)
        ? `[${v.map(canonical).join(",")}]`
        : `{${Object.entries(v)
            .filter(([, x]) => x !== undefined)
            .sort(([a], [b]) => a.localeCompare(b, "en"))
            .map(([k, x]) => JSON.stringify(k) + ":" + canonical(x))
            .join(",")}}`;
  return createHash("sha256").update(canonical(value)).digest("hex");
}
function letters(column: number): string {
  let value = "";
  for (; column > 0; column = Math.floor((column - 1) / 26))
    value = String.fromCharCode(65 + ((column - 1) % 26)) + value;
  return value;
}
function range(a: z.infer<z.ZodObject<typeof rectangle>>): string {
  return `'${a.sheetTitle.replaceAll("'", "''")}'!${letters(a.startColumn)}${a.startRow}:${letters(a.startColumn + a.columnCount - 1)}${a.startRow + a.rowCount - 1}`;
}
const docs = "https://docs.googleapis.com/v1",
  sheets = "https://sheets.googleapis.com/v4",
  slides = "https://slides.googleapis.com/v1";
/** Only declared native operations; the application supplies exact action authorization on every request. */
export async function executeGoogleWorkspace(options: {
  connection: IntegrationConnection;
  action: AuthorizedIntegrationAction;
  token: string;
  transport: HttpTransport;
  authorize: () => Promise<void>;
}): Promise<IntegrationResult> {
  const { connection: c, action, token: accessToken, transport, authorize } = options,
    cap = googleWorkspaceCapabilities.find((t) => t.id === action.toolId);
  if (!cap) throw new IntegrationError("configuration", "Native Google-Capability fehlt.");
  const a = cap.inputSchema.parse(action.args) as Record<string, unknown>;
  if (a.targetConfigSha256 !== googleConfigurationSha256(c))
    throw new IntegrationError("authorization", "Google-Zielkonfiguration hat sich geändert.");
  const resource = (value: unknown) => {
    if (typeof value !== "string" || !c.resourceIds?.includes(value))
      throw new IntegrationError("authorization", "Google-Ressource ist nicht freigegeben.");
  };
  for (const key of ["folderId", "documentId", "spreadsheetId", "presentationId"])
    if (a[key] !== undefined) resource(a[key]);
  if (action.toolId === "gsheets.create" || action.toolId === "gsheets.version.create") resource("create:spreadsheets");
  if (action.toolId === "gslides.create") resource("create:presentations");
  const writing = cap.effect !== "read";
  const request = async (url: string, method = "GET", body?: unknown, contentType = "application/json") => {
    await authorize();
    const result = await transport({
      url,
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": contentType } : {}),
      },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      trustedEndpoint: true,
      maxBytes: 2 * 1024 * 1024,
      timeoutMs: method === "GET" ? 30000 : 60000,
    });
    if (result.status === 400 && body && typeof body === "object" && "writeControl" in body)
      throw new IntegrationError(
        "conflict",
        "Google hat die Revisions- oder Änderungsbedingung abgelehnt.",
        "failed",
        400,
      );
    checkResponse(result, method !== "GET");
    try {
      return JSON.parse(result.body.toString()) as Record<string, unknown>;
    } catch {
      throw new IntegrationError(
        "provider",
        "Google-Antwort ist unvollständig.",
        method === "GET" ? "failed" : "effect_unknown",
      );
    }
  };
  const result = (data: unknown, externalId?: string): IntegrationResult => ({
    observedAt: new Date().toISOString(),
    effectStatus: "succeeded",
    externalId,
    evidenceRefs: [],
    data,
  });
  const validate = <T>(schema: z.ZodType<T>, value: unknown, effectWriting = writing): T => {
    const p = schema.safeParse(value);
    if (!p.success)
      throw new IntegrationError(
        "provider",
        "Google-Antwort erfüllt den nativen Vertrag nicht.",
        effectWriting ? "effect_unknown" : "failed",
      );
    return p.data;
  };
  const readSheet = async () => {
    const r = range(a as z.infer<z.ZodObject<typeof rectangle>>),
      payload = validate(
        z.object({ range: z.string(), majorDimension: z.literal("ROWS").optional(), values: rows.optional() }),
        await request(
          `${sheets}/spreadsheets/${encodeURIComponent(String(a.spreadsheetId))}/values/${encodeURIComponent(r)}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`,
        ),
        false,
      );
    const values = payload.values ?? [];
    if (values.length > Number(a.rowCount) || values.some((row) => row.length > Number(a.columnCount)))
      throw new IntegrationError("provider", "Google lieferte Werte außerhalb des ausgewählten Rechtecks.");
    const snapshot = { spreadsheetId: String(a.spreadsheetId), range: r, values };
    return { ...snapshot, contentSha256: googleConfigurationSha256(snapshot), formulaHandling: "materialized_values" };
  };
  const createSheet = async (values: z.infer<typeof rows>, sheetTitle: string) => {
    rows.parse(values);
    const data = {
      properties: { title: a.title },
      sheets: [
        {
          properties: {
            title: sheetTitle,
            gridProperties: {
              rowCount: Math.max(1, values.length),
              columnCount: Math.max(1, ...values.map((r) => r.length)),
            },
          },
          data: [
            {
              startRow: 0,
              startColumn: 0,
              rowData: values.map((row) => ({
                values: row.map((value) =>
                  value === null
                    ? {}
                    : {
                        userEnteredValue:
                          typeof value === "string"
                            ? { stringValue: value }
                            : typeof value === "number"
                              ? { numberValue: value }
                              : { boolValue: value },
                      },
                ),
              })),
            },
          ],
        },
      ],
    };
    return validate(
      z.object({ spreadsheetId: id, spreadsheetUrl: z.url().optional() }),
      await request(`${sheets}/spreadsheets`, "POST", data),
    );
  };
  switch (action.toolId) {
    case "gdocs.create": {
      const drive = c.baseUrl ?? "https://www.googleapis.com",
        endpoint = new URL(drive);
      if (
        endpoint.username ||
        endpoint.password ||
        endpoint.hash ||
        endpoint.search ||
        (endpoint.protocol !== "https:" && !(c.allowHttp && endpoint.protocol === "http:"))
      )
        throw new IntegrationError("configuration", "Google-Drive-Endpunkt ist ungültig.");
      const boundary = "ironcrew_" + randomUUID();
      const metadata = {
        name: a.title,
        mimeType: "application/vnd.google-apps.document",
        parents: [a.folderId],
        appProperties: {
          ironcrewActionId: action.id,
          ironcrewContentSha256: createHash("sha256").update(String(a.text)).digest("hex"),
        },
      };
      const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${a.text}\r\n--${boundary}--\r\n`;
      const created = validate(
        z.object({
          id,
          mimeType: z.literal("application/vnd.google-apps.document"),
          name: z.string().optional(),
          version: z.string().optional(),
        }),
        await request(
          drive.replace(/\/$/, "") + "/upload/drive/v3/files?uploadType=multipart&fields=id,mimeType,name,version",
          "POST",
          body,
          `multipart/related; boundary=${boundary}`,
        ),
      );
      return result(
        { ...created, contentSha256: metadata.appProperties.ironcrewContentSha256, format: "native_google_document" },
        created.id,
      );
    }
    case "gdocs.read": {
      const data = validate(
        z.object({
          documentId: id,
          title: z.string(),
          revisionId: revision,
          tabs: z.array(z.record(z.string(), z.unknown())).optional(),
          body: z.record(z.string(), z.unknown()).optional(),
        }),
        await request(`${docs}/documents/${a.documentId}?includeTabsContent=true`),
      );
      if (data.documentId !== a.documentId)
        throw new IntegrationError("provider", "Google-Dokument-ID stimmt nicht überein.");
      return result(data, data.documentId);
    }
    case "gdocs.append":
    case "gdocs.replace": {
      const requests =
        action.toolId === "gdocs.append"
          ? [{ insertText: { endOfSegmentLocation: { tabId: a.tabId }, text: a.text } }]
          : [
              { deleteContentRange: { range: { tabId: a.tabId, startIndex: a.startIndex, endIndex: a.endIndex } } },
              ...(a.text ? [{ insertText: { location: { tabId: a.tabId, index: a.startIndex }, text: a.text } }] : []),
            ];
      const updated = validate(
        z.object({
          documentId: id,
          writeControl: z.object({ requiredRevisionId: revision }),
          replies: z.array(z.unknown()),
        }),
        await request(`${docs}/documents/${a.documentId}:batchUpdate`, "POST", {
          writeControl: { requiredRevisionId: a.requiredRevisionId },
          requests,
        }),
      );
      if (updated.documentId !== a.documentId)
        throw new IntegrationError(
          "provider",
          "Google-Änderungsantwort gehört zu einem anderen Dokument.",
          "effect_unknown",
        );
      return result(
        { documentId: updated.documentId, revisionId: updated.writeControl.requiredRevisionId },
        updated.documentId,
      );
    }
    case "gsheets.read":
      return result(await readSheet(), String(a.spreadsheetId));
    case "gsheets.create": {
      const created = await createSheet(a.rows as z.infer<typeof rows>, String(a.sheetTitle));
      return result(
        { ...created, format: "native_google_spreadsheet", formulaHandling: "literal_values" },
        created.spreadsheetId,
      );
    }
    case "gsheets.version.create": {
      const before = await readSheet();
      if (before.contentSha256 !== a.expectedContentSha256)
        throw new IntegrationError("conflict", "Google-Tabellenausschnitt hat sich seit der Freigabe geändert.");
      const values = Array.from({ length: Number(a.rowCount) }, (_, r) =>
        Array.from({ length: Number(a.columnCount) }, (_, column) => before.values[r]?.[column] ?? null),
      );
      const edits = a.edits as Array<{ row: number; column: number; value: z.infer<typeof cell> }>;
      if (
        new Set(edits.map((e) => `${e.row}:${e.column}`)).size !== edits.length ||
        edits.some((e) => e.row >= Number(a.rowCount) || e.column >= Number(a.columnCount))
      )
        throw new IntegrationError("validation", "Zelländerungen sind doppelt oder liegen außerhalb des Ausschnitts.");
      for (const edit of edits) values[edit.row]![edit.column] = edit.value;
      const created = await createSheet(values, String(a.newSheetTitle));
      return result(
        {
          ...created,
          source: { spreadsheetId: a.spreadsheetId, range: before.range, contentSha256: before.contentSha256 },
          sourceUnchanged: true,
          representation: "new_rectangle_snapshot",
          formulaHandling: "materialized_values",
        },
        created.spreadsheetId,
      );
    }
    case "gslides.create": {
      const created = validate(
        z.object({ presentationId: id, title: z.string().optional() }),
        await request(`${slides}/presentations`, "POST", { title: a.title }),
      );
      return result({ ...created, empty: true }, created.presentationId);
    }
    case "gslides.read": {
      const data = validate(
        z.object({
          presentationId: id,
          revisionId: revision,
          title: z.string().optional(),
          slides: z.array(z.record(z.string(), z.unknown())).optional(),
        }),
        await request(`${slides}/presentations/${a.presentationId}`),
      );
      if (data.presentationId !== a.presentationId)
        throw new IntegrationError("provider", "Google-Präsentations-ID stimmt nicht überein.");
      return result(data, data.presentationId);
    }
    case "gslides.text.replace": {
      const updated = validate(
        z.object({
          presentationId: id,
          writeControl: z.object({ requiredRevisionId: revision }),
          replies: z.array(z.unknown()),
        }),
        await request(`${slides}/presentations/${a.presentationId}:batchUpdate`, "POST", {
          writeControl: { requiredRevisionId: a.requiredRevisionId },
          requests: [
            { deleteText: { objectId: a.objectId, textRange: { type: "ALL" } } },
            { insertText: { objectId: a.objectId, insertionIndex: 0, text: a.text } },
          ],
        }),
      );
      if (updated.presentationId !== a.presentationId)
        throw new IntegrationError(
          "provider",
          "Google-Änderungsantwort gehört zu einer anderen Präsentation.",
          "effect_unknown",
        );
      return result(
        { presentationId: updated.presentationId, revisionId: updated.writeControl.requiredRevisionId },
        updated.presentationId,
      );
    }
    default:
      throw new IntegrationError("configuration", "Native Google-Capability fehlt.");
  }
}
