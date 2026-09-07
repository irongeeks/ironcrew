import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { IntegrationService, type IntegrationConnection } from "../../packages/integrations/src/service.ts";
import { createHttpTransport, type HttpRequest } from "../../packages/integrations/src/transport.ts";
import {
  googleConfigurationSha256,
  googleWorkspaceCapabilities,
} from "../../packages/integrations/src/google-workspace.ts";
export async function googleWorkspaceFixture() {
  const seen: Array<{ path: string; method: string; body: string; authorization?: string }> = [],
    state = {
      docRevision: "r1",
      docText: "before",
      slideRevision: "s1",
      slideText: "old",
      values: [["label", 17]] as Array<Array<string | number>>,
      failCreate: false,
      createdSheets: [] as Array<Record<string, unknown>>,
    };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const url = new URL(req.url!, "http://fixture"),
        route = url.pathname;
      seen.push({ path: req.url!, method: req.method!, body, authorization: req.headers.authorization });
      res.setHeader("content-type", "application/json");
      const send = (data: unknown, status = 200) => {
        res.statusCode = status;
        res.end(JSON.stringify(data));
      };
      const parsed = body.startsWith("{") ? JSON.parse(body) : {};
      if (route.includes("/upload/drive/v3/files"))
        return send({ id: "created-doc", mimeType: "application/vnd.google-apps.document", version: "1" });
      if (route.endsWith("/documents/doc-a") && req.method === "GET")
        return send({
          documentId: "doc-a",
          title: "Report",
          revisionId: state.docRevision,
          tabs: [
            {
              documentTab: {
                body: { content: [{ paragraph: { elements: [{ textRun: { content: state.docText } }] } }] },
              },
            },
          ],
        });
      if (route.endsWith("/documents/doc-a:batchUpdate")) {
        if (parsed.writeControl?.requiredRevisionId !== state.docRevision)
          return send({ error: { status: "FAILED_PRECONDITION" } }, 400);
        state.docText += parsed.requests[0]?.insertText?.text ?? " replacement";
        state.docRevision = "r2";
        return send({
          documentId: "doc-a",
          writeControl: { requiredRevisionId: "r2" },
          replies: parsed.requests.map(() => ({})),
        });
      }
      if (route.includes("/spreadsheets/sheet-a/values/"))
        return send({
          range: decodeURIComponent(route.split("/values/")[1]!),
          majorDimension: "ROWS",
          values: state.values,
        });
      if (route.endsWith("/v4/spreadsheets") && req.method === "POST") {
        state.createdSheets.push(parsed);
        if (state.failCreate) return send({ error: { message: "indeterminate" } }, 500);
        return send({
          spreadsheetId: "created-sheet",
          spreadsheetUrl: "https://docs.google.com/spreadsheets/d/created-sheet/edit",
        });
      }
      if (route.endsWith("/presentations") && req.method === "POST")
        return send({ presentationId: "created-slides", title: parsed.title });
      if (route.endsWith("/presentations/pres-a") && req.method === "GET")
        return send({
          presentationId: "pres-a",
          revisionId: state.slideRevision,
          title: "Report",
          slides: [{ objectId: "slide-a", pageElements: [{ objectId: "text-a" }] }],
        });
      if (route.endsWith("/presentations/pres-a:batchUpdate")) {
        if (parsed.writeControl?.requiredRevisionId !== state.slideRevision) return send({ error: {} }, 412);
        state.slideText = parsed.requests[1].insertText.text;
        state.slideRevision = "s2";
        return send({ presentationId: "pres-a", writeControl: { requiredRevisionId: "s2" }, replies: [{}, {}] });
      }
      send({ error: "unknown fixture route" }, 404);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    connection: IntegrationConnection = {
      id: randomUUID(),
      provider: "gdrive",
      scope: { companyId: randomUUID(), areaId: randomUUID() },
      secretRef: { provider: "proton-pass", shareId: "fixture", itemId: "fixture", field: "token" },
      enabledTools: googleWorkspaceCapabilities.map((c) => c.id),
      resourceIds: ["folder-a", "doc-a", "sheet-a", "pres-a", "create:spreadsheets", "create:presentations"],
      schemaTag: "native-google-fixture",
    };
  const transport = (input: HttpRequest) => {
    const url = new URL(input.url);
    if (
      !["docs.googleapis.com", "sheets.googleapis.com", "slides.googleapis.com", "www.googleapis.com"].includes(
        url.hostname,
      )
    )
      throw Error("unexpected fixture host");
    return createHttpTransport()({ ...input, url: origin + "/" + url.hostname + url.pathname + url.search });
  };
  const service = new IntegrationService({
    connections: [connection],
    secrets: { resolve: async () => "fixture-access-token" },
    authorize: async () => {},
    transport,
  });
  const call = (toolId: string, args: Record<string, unknown>) =>
    service.execute({
      id: randomUUID(),
      scope: connection.scope,
      targetId: connection.id,
      toolId,
      args: { targetConfigSha256: googleConfigurationSha256(connection), ...args },
    });
  return {
    connection,
    service,
    transport,
    seen,
    state,
    call,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
