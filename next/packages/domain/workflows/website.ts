import { tmpdir } from "node:os";
import { create as createTar } from "tar";
import { safeRelative } from "../../tools/isolation/files.ts";
import { safeSiteHtml, siteResponseSecurityPolicy } from "../../tools/site-safety.ts";
import { siteProject, buildSiteProject } from "../../tools/site-build.ts";
import type { ExecutionPort, ExecutionContext } from "../../tools/isolation/index.ts";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { Repository } from "../../persistence/src/index.ts";
import { Workspace, digest } from "../../tools/workspace.ts";
import { DomainError } from "../src/index.ts";
import type { Scope } from "../../contracts/src/index.ts";
import { ManagedActions, type ActionRequest } from "./actions.ts";
export const conceptSchema = z.object({
  name: z.string().min(1),
  rationale: z.string().min(1),
  html: z.string().min(1).max(1000000),
});
export type Concept = z.infer<typeof conceptSchema> & { id: string; sha256: string };
export const sitePinInputSchema = z
  .object({
    artifactVersionId: z.uuid(),
    viewport: z.object({
      width: z.number().int().positive().max(10000),
      height: z.number().int().positive().max(10000),
    }),
    anchor: z.string().min(1).max(1000),
    comment: z.string().trim().min(1).max(10000),
    source: z.enum(["chat", "pin"]).default("pin"),
    deferDispatch: z.boolean().default(false),
  })
  .strict();
export const siteRevisionInputSchema = z
  .object({
    expectedArtifactVersionId: z.uuid(),
    html: z.string().min(1).max(1000000),
    changeDescription: z.string().trim().min(1).max(4000),
    feedbackIds: z.array(z.uuid()).max(50).default([]),
  })
  .strict();
export type Site = {
  id: string;
  orderId: string;
  briefing: string;
  stack: "static" | "react" | "wordpress";
  concepts: Concept[];
  selectedConceptId?: string;
  sourceRevisionId?: string;
  predecessorArtifactVersionId?: string;
  artifactVersionId?: string;
  sha256?: string;
  state: "briefing" | "concepts" | "selected" | "built" | "reviewed" | "accepted" | "published";
  acceptedVersionId?: string;
  previewUrl?: string;
};
export class WebsiteWorkflow {
  repo: Repository;
  directory: string;
  getExecutionPort?: () => Promise<ExecutionPort | undefined>;
  constructor(repo: Repository, directory: string, getExecutionPort?: () => Promise<ExecutionPort | undefined>) {
    this.getExecutionPort = getExecutionPort;
    this.repo = repo;
    this.directory = directory;
  }
  async create(scope: Scope, orderId: string, briefing: string, stack: Site["stack"] = "static") {
    z.object({ briefing: z.string().trim().min(1), stack: z.enum(["static", "react", "wordpress"]) }).parse({
      briefing,
      stack,
    });
    await this.repo.getOrder(scope, orderId);
    return this.repo.putDocument<Site>(scope, "website", orderId, {
      id: orderId,
      orderId,
      briefing,
      stack,
      concepts: [],
      state: "briefing",
    });
  }
  async concepts(scope: Scope, orderId: string, inputs: unknown) {
    const concepts = z.array(conceptSchema).min(2).max(10).parse(inputs);
    const site = await this.required(scope, orderId);
    if (!["briefing", "concepts"].includes(site.data.state)) throw new DomainError("concept_selection_locked");
    const versions = concepts.map((c) => ({ ...c, id: randomUUID(), sha256: digest(c.html) }));
    await this.repo.transact(
      scope,
      [
        {
          kind: "website-concept-set",
          id: randomUUID(),
          data: { orderId, concepts: versions, createdAt: new Date().toISOString() },
          immutable: true,
        },
        {
          kind: "website",
          id: orderId,
          data: { ...site.data, concepts: versions, state: "concepts" },
          expectedRevision: site.revision,
        },
      ],
      { type: "website.concepts_created", aggregateId: orderId },
    );
    return this.required(scope, orderId);
  }
  async revise(scope: Scope, orderId: string, input: unknown) {
    const parsed = siteRevisionInputSchema.parse(input),
      site = await this.required(scope, orderId);
    if (site.data.artifactVersionId !== parsed.expectedArtifactVersionId) throw new DomainError("stale_artifact");
    const selected = site.data.concepts.find((c) => c.id === site.data.selectedConceptId);
    if (!selected) throw new DomainError("concept_selection_required");
    for (const id of parsed.feedbackIds) {
      const pin = await this.repo.getDocument<{ orderId: string; state: string }>(scope, "site-pin", id);
      if (!pin || pin.data.orderId !== orderId || pin.data.state !== "open")
        throw new DomainError("feedback_not_submitted");
    }
    const id = randomUUID(),
      concept = { ...selected, id: randomUUID(), html: parsed.html, sha256: digest(parsed.html) };
    await this.repo.transact(
      scope,
      [
        {
          kind: "website-revision",
          id,
          data: {
            id,
            orderId,
            ...parsed,
            conceptId: concept.id,
            htmlSha256: concept.sha256,
            createdAt: new Date().toISOString(),
          },
          immutable: true,
        },
        {
          kind: "website",
          id: orderId,
          data: {
            ...site.data,
            concepts: [...site.data.concepts, concept],
            selectedConceptId: concept.id,
            sourceRevisionId: id,
            predecessorArtifactVersionId: parsed.expectedArtifactVersionId,
            acceptedVersionId: undefined,
            state: "selected",
          },
          expectedRevision: site.revision,
        },
      ],
      { type: "website.revision_prepared", aggregateId: orderId, data: { sourceRevisionId: id } },
    );
    return this.required(scope, orderId);
  }
  async select(scope: Scope, orderId: string, conceptId: string) {
    const site = await this.required(scope, orderId);
    if (!site.data.concepts.some((c) => c.id === conceptId)) throw new DomainError("concept_not_found");
    return this.repo.putDocument(
      scope,
      "website",
      orderId,
      {
        ...site.data,
        selectedConceptId: conceptId,
        state: "selected",
        acceptedVersionId: undefined,
        artifactVersionId: undefined,
        sha256: undefined,
        previewUrl: undefined,
        sourceRevisionId: undefined,
        predecessorArtifactVersionId: site.data.artifactVersionId,
      },
      { expectedRevision: site.revision },
    );
  }
  async build(scope: Scope, orderId: string, executionContext?: ExecutionContext) {
    const site = await this.required(scope, orderId);
    const concept = site.data.concepts.find((c) => c.id === site.data.selectedConceptId);
    if (!concept) throw new DomainError("concept_selection_required");
    const executionPort = site.data.stack !== "static" ? await this.getExecutionPort?.() : undefined;
    if (site.data.stack !== "static" && !executionPort) throw new DomainError("isolated_build_worker_required");
    const versionId = randomUUID();
    const workspace = new Workspace(path.join(this.directory, "sites", versionId));
    await workspace.init();
    const server = `import {createServer} from 'node:http';import {readFile} from 'node:fs/promises';if(process.version!=='v26.4.0')throw new Error('Node 26.4.0 required');const html=await readFile(new URL('./index.html',import.meta.url));const app=createServer((req,res)=>{if(req.url!=='/'&&req.url!=='/index.html'){res.writeHead(404);return res.end();}res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','X-Content-Type-Options':'nosniff','Content-Security-Policy':${JSON.stringify(siteResponseSecurityPolicy)}});res.end(html);}).listen(Number(process.env.PORT||3000),'127.0.0.1',()=>{if(process.send)process.send({port:app.address().port});});\n`;
    const files = [
      { path: "index.html", content: safeSiteHtml(concept.html).document, expectedSha256: null },
      { path: "server.mjs", content: server, expectedSha256: null },
      {
        path: "README.md",
        content:
          "# Selbsthosting\n\nNode 26.4.0 installieren. `node server.mjs` startet auf 127.0.0.1:3000. PORT ist konfigurierbar. Konzept-HTML wird vor der Ausgabe bereinigt; Skripte, Eventattribute und aktive Einbettungen werden entfernt. HTML und Server liefern eine CSP mit lokalen Skripten, Inline-CSS und HTTPS-Bildern; Formulare und Netzwerk-APIs sind gesperrt. Für externen Zugriff eigenen TLS-Reverse-Proxy einrichten. Updates: neue geprüfte Version in eigenes Verzeichnis entpacken, Dienst stoppen, Pfad wechseln, starten und Funktion prüfen; altes Verzeichnis für Rückweg aufbewahren. Diese Übergabe ist kein bestätigter Livebetrieb.\n",
        expectedSha256: null,
      },
    ];
    let buildEvidence: unknown;
    if (site.data.stack === "static") await workspace.applyPatch({ files });
    else {
      const project = await siteProject(site.data.stack, concept.html);
      await workspace.applyPatch({
        files: Object.entries(project).map(([path, content]) => ({ path, content, expectedSha256: null })),
      });
      const built = await buildSiteProject(workspace.root, site.data.stack, executionPort!, executionContext);
      buildEvidence = {
        ...built.result,
        outputDirectory: undefined,
        php: built.php ? { ...built.php, outputDirectory: undefined } : undefined,
      };
    }
    const previewPath = site.data.stack === "static" ? "index.html" : "dist/index.html";
    const html = await readFile(path.join(workspace.root, previewPath));
    const htmlSha256 = digest(html);
    const hashes = await workspace.snapshotHashes();
    const manifest = {
      files: await Promise.all(
        Object.entries(hashes).map(async ([relative, sha256]) => ({
          path: relative,
          sha256,
          bytes: (await readFile(await workspace.resolve(relative))).length,
        })),
      ),
    };
    const manifestHash = digest(JSON.stringify(manifest.files));
    await mkdir(path.join(this.directory, "blobs"), { recursive: true, mode: 0o700 });
    await writeFile(path.join(this.directory, "blobs", htmlSha256), html, {
      flag: "wx",
      mode: 0o600,
    }).catch(async (e: NodeJS.ErrnoException) => {
      if (e.code !== "EEXIST") throw e;
      if (digest(await readFile(path.join(this.directory, "blobs", htmlSha256))) !== htmlSha256)
        throw new DomainError("blob_corrupt");
    });
    const artifact = {
      id: versionId,
      artifactId: orderId,
      scope,
      orderId,
      sha256: htmlSha256,
      packageSha256: manifestHash,
      mediaType: "text/html",
      bytes: html.length,
      stack: site.data.stack,
      ...(site.data.sourceRevisionId
        ? {
            sourceRevisionId: site.data.sourceRevisionId,
            predecessorArtifactVersionId: site.data.predecessorArtifactVersionId,
          }
        : {}),
      previewPath,
      buildEvidence,
      canonicalStore: "internal",
      delivery: "staged",
      files: manifest.files,
      createdAt: new Date().toISOString(),
    };
    await this.repo.transact(
      scope,
      [
        { kind: "artifact", id: versionId, data: artifact, immutable: true },
        {
          kind: "website",
          id: orderId,
          data: {
            ...site.data,
            state: "built",
            artifactVersionId: versionId,
            sha256: manifestHash,
            acceptedVersionId: undefined,
            previewUrl: `/${versionId}/`,
          },
          expectedRevision: site.revision,
        },
      ],
      { type: "website.built", aggregateId: orderId },
    );
    return artifact;
  }
  async pin(scope: Scope, orderId: string, input: unknown) {
    const { deferDispatch, ...pin } = sitePinInputSchema.parse(input);
    const artifact = await this.repo.getDocument<{ orderId: string }>(scope, "artifact", pin.artifactVersionId);
    if (artifact?.data.orderId !== orderId) throw new DomainError("artifact_scope_denied");
    const id = randomUUID();
    const site = await this.required(scope, orderId);
    const data = {
      ...pin,
      id,
      orderId,
      state: deferDispatch ? "draft" : "open",
      createdAt: new Date().toISOString(),
      ...(deferDispatch ? {} : { sourceMessageId: id }),
    };
    const message = { id, orderId, role: "user", content: pin.comment, createdAt: data.createdAt };
    await this.repo.transact(
      scope,
      [
        { kind: "site-pin", id, data },
        ...(!deferDispatch
          ? [
              { kind: "message", id, data: message, immutable: true },
              {
                kind: "run-inbox",
                id,
                data: { ...message, content: JSON.stringify({ type: "website_change_request", feedback: data }) },
                immutable: true,
              },
            ]
          : []),
        {
          kind: "website",
          id: orderId,
          data: {
            ...site.data,
            state: site.data.artifactVersionId && site.data.state !== "selected" ? "built" : site.data.state,
            acceptedVersionId: undefined,
          },
          expectedRevision: site.revision,
        },
      ],
      { type: "website.feedback_received", aggregateId: orderId },
    );
    return (await this.repo.getDocument<typeof data>(scope, "site-pin", id))!;
  }
  async submitFeedback(scope: Scope, orderId: string, input: unknown) {
    const ids = z
      .array(z.uuid())
      .min(1)
      .max(50)
      .refine((v) => new Set(v).size === v.length)
      .parse(input);
    const site = await this.required(scope, orderId);
    const pins = await Promise.all(
      ids.map(async (id) => {
        const doc = await this.repo.getDocument<{
          orderId: string;
          state: string;
          comment: string;
          artifactVersionId: string;
        }>(scope, "site-pin", id);
        if (!doc || doc.data.orderId !== orderId || doc.data.state !== "draft")
          throw new DomainError("feedback_not_draft");
        return doc;
      }),
    );
    const id = randomUUID(),
      createdAt = new Date().toISOString();
    const message = {
      id,
      orderId,
      role: "user",
      content: pins.map((p, i) => `${i + 1}. ${p.data.comment}`).join("\n"),
      createdAt,
    };
    await this.repo.transact(
      scope,
      [
        ...pins.map((pin) => ({
          kind: "site-pin",
          id: pin.id,
          data: { ...pin.data, state: "open", sourceMessageId: id, submittedAt: createdAt },
          expectedRevision: pin.revision,
        })),
        {
          kind: "website",
          id: orderId,
          data: {
            ...site.data,
            state: site.data.artifactVersionId && site.data.state !== "selected" ? "built" : site.data.state,
            acceptedVersionId: undefined,
          },
          expectedRevision: site.revision,
        },
        { kind: "message", id, data: message, immutable: true },
        {
          kind: "run-inbox",
          id,
          data: {
            ...message,
            content: JSON.stringify({ type: "website_change_requests", feedback: pins.map((p) => p.data) }),
          },
          immutable: true,
        },
      ],
      { type: "website.feedback_submitted", aggregateId: orderId, data: { messageId: id, pinIds: ids } },
    );
    return { messageId: id, pinIds: ids };
  }
  async resolvePin(
    scope: Scope,
    orderId: string,
    pinId: string,
    input: { artifactVersionId: string; evidence: string; reviewerId: string },
  ) {
    const site = await this.required(scope, orderId),
      setup = await this.repo.snapshot(scope.companyId);
    if (input.reviewerId !== setup.ceo.id) throw new DomainError("ceo_required");
    if (
      site.data.state === "selected" ||
      site.data.artifactVersionId !== input.artifactVersionId ||
      !input.evidence.trim()
    )
      throw new DomainError("pin_resolution_invalid");
    const pin = await this.repo.getDocument<{ orderId: string; state: string }>(scope, "site-pin", pinId);
    if (!pin || pin.data.orderId !== orderId) throw new DomainError("pin_not_found");
    if (pin.data.state !== "open") throw new DomainError("feedback_not_submitted");
    return this.repo.putDocument(
      scope,
      "site-pin",
      pinId,
      {
        ...pin.data,
        state: "resolved",
        resolvedArtifactVersionId: input.artifactVersionId,
        evidence: input.evidence,
        reviewerId: input.reviewerId,
      },
      { expectedRevision: pin.revision },
    );
  }
  async review(
    scope: Scope,
    orderId: string,
    input: {
      artifactVersionId: string;
      reviewerId: string;
      reviewerKind?: "ceo" | "employee";
      checks: { name: string; passed: boolean; evidence: string }[];
    },
  ) {
    z.object({
      artifactVersionId: z.uuid(),
      reviewerId: z.uuid(),
      reviewerKind: z.enum(["ceo", "employee"]).optional(),
      checks: z
        .array(z.object({ name: z.string().trim().min(1), passed: z.boolean(), evidence: z.string().trim().min(1) }))
        .min(1),
    })
      .strict()
      .parse(input);
    const site = await this.required(scope, orderId);
    if (site.data.artifactVersionId !== input.artifactVersionId) throw new DomainError("stale_artifact");
    if (!["built", "reviewed", "accepted", "published"].includes(site.data.state))
      throw new DomainError("site_build_required");
    if (
      new Set(input.checks.map((c) => c.name)).size !== input.checks.length ||
      !["mobile", "functional", "quality"].every((name) => input.checks.some((c) => c.name === name))
    )
      throw new DomainError("required_site_checks_missing");
    const order = await this.repo.getOrder(scope, orderId),
      setup = await this.repo.snapshot(scope.companyId);
    if (input.reviewerKind === "ceo" && input.reviewerId !== setup.ceo.id) throw new DomainError("ceo_required");
    if (input.reviewerKind !== "ceo" && !setup.employees.some((e) => e.id === input.reviewerId))
      throw new DomainError("reviewer_not_found");
    if (input.reviewerKind !== "ceo" && order.leadEmployeeId === input.reviewerId)
      throw new DomainError("independent_review_required");
    const id = randomUUID(),
      passed = input.checks.every((c) => c.passed);
    await this.repo.transact(
      scope,
      [
        {
          kind: "review",
          id,
          data: {
            ...input,
            id,
            orderId,
            actor: input.reviewerKind === "ceo" ? "human" : "agent",
            passed,
            createdAt: new Date().toISOString(),
          },
          immutable: true,
        },
        {
          kind: "website",
          id: orderId,
          data: { ...site.data, state: passed ? "reviewed" : "built", acceptedVersionId: undefined, reviewId: id },
          expectedRevision: site.revision,
        },
      ],
      { type: "website.reviewed", aggregateId: orderId },
    );
    return { id, passed };
  }
  async accept(scope: Scope, orderId: string, versionId: string) {
    const site = await this.required(scope, orderId);
    if (site.data.state !== "reviewed" || site.data.artifactVersionId !== versionId)
      throw new DomainError("acceptance_checks_required");
    const openPins = (await this.repo.listDocuments<{ orderId: string; state: string }>(scope, "site-pin")).filter(
      (p) => p.data.orderId === orderId && p.data.state === "open",
    );
    if (openPins.length) throw new DomainError("unresolved_site_pins");
    return this.repo.putDocument(
      scope,
      "website",
      orderId,
      { ...site.data, state: "accepted", acceptedVersionId: versionId },
      { expectedRevision: site.revision },
    );
  }
  async publish(
    scope: Scope,
    orderId: string,
    actions: ManagedActions,
    request: Omit<ActionRequest, "scope" | "orderId" | "toolId" | "effect" | "args" | "artifactVersionId">,
    deploy: (
      versionId: string,
      hash: string,
    ) => Promise<{ url: string; httpsVerified: boolean; functionalCheckPassed: boolean; rollbackRef: string }>,
  ) {
    const site = await this.required(scope, orderId);
    if (site.data.state !== "accepted" || site.data.acceptedVersionId !== site.data.artifactVersionId)
      throw new DomainError("site_not_accepted");
    const result = await actions.perform(
      {
        ...request,
        scope,
        orderId,
        toolId: "website.publish",
        effect: "publish",
        artifactVersionId: site.data.artifactVersionId,
        args: { artifactVersionId: site.data.artifactVersionId!, sha256: site.data.sha256! },
      },
      async () => {
        const current = await this.required(scope, orderId);
        if (
          current.data.state !== "accepted" ||
          current.data.artifactVersionId !== site.data.artifactVersionId ||
          current.data.acceptedVersionId !== site.data.artifactVersionId
        )
          throw new DomainError("site_acceptance_changed");
        return deploy(site.data.artifactVersionId!, site.data.sha256!);
      },
    );
    if (result.state === "succeeded") {
      const data = z
        .object({
          url: z.url().refine((url) => new URL(url).protocol === "https:"),
          httpsVerified: z.literal(true),
          functionalCheckPassed: z.literal(true),
          rollbackRef: z.string().min(1),
        })
        .safeParse(result.data);
      if (!data.success) throw new DomainError("published_health_unverified");
      await this.repo.putDocument(
        scope,
        "website",
        orderId,
        { ...site.data, state: "published", publication: data.data },
        { expectedRevision: site.revision },
      );
    }
    return result;
  }
  async preview(versionId: string) {
    return (await this.previewAsset(versionId, "index.html")).content;
  }
  async previewAsset(versionId: string, relative: string) {
    z.uuid().parse(versionId);
    if (!safeRelative(relative)) throw new DomainError("preview_path_denied", undefined, 404);
    const setup = await this.repo.setupState();
    if (!setup) throw new DomainError("artifact_not_found", undefined, 404);
    const artifact = (
      await this.repo.listCompanyDocuments<{
        stack?: string;
        previewPath?: string;
        files?: { path: string; sha256: string }[];
      }>(setup.company.id, "artifact")
    ).find((a) => a.id === versionId);
    if (!artifact?.data.files) throw new DomainError("artifact_not_found", undefined, 404);
    const prefix = path.posix.dirname(artifact.data.previewPath ?? "index.html"),
      file = prefix === "." ? relative : prefix + "/" + relative;
    const expected = artifact.data.files.find((f) => f.path === file);
    const mediaTypes: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".mjs": "text/javascript; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".json": "application/json",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".svg": "image/svg+xml",
      ".woff2": "font/woff2",
    };
    const mediaType = mediaTypes[path.extname(relative)];
    if (!expected || !mediaType) throw new DomainError("preview_path_denied", undefined, 404);
    const workspace = new Workspace(path.join(this.directory, "sites", versionId));
    const content = await readFile(await workspace.resolve(file));
    if (digest(content) !== expected.sha256) throw new DomainError("artifact_corrupt");
    return { content, mediaType, allowScripts: artifact.data.stack === "react" };
  }
  async packageArchive(scope: Scope, versionId: string) {
    z.uuid().parse(versionId);
    const artifact = await this.repo.getDocument<{
      files?: { path: string; sha256: string; bytes: number }[];
      packageSha256?: string;
    }>(scope, "artifact", versionId);
    if (!artifact?.data.files || digest(JSON.stringify(artifact.data.files)) !== artifact.data.packageSha256)
      throw new DomainError("site_package_missing");
    const staging = await mkdtemp(path.join(tmpdir(), "ironcrew-site-package-"));
    try {
      const workspace = new Workspace(path.join(this.directory, "sites", versionId));
      for (const file of artifact.data.files) {
        if (!safeRelative(file.path)) throw new DomainError("site_package_path_invalid");
        const content = await readFile(await workspace.resolve(file.path));
        if (content.length !== file.bytes || digest(content) !== file.sha256) throw new DomainError("artifact_corrupt");
        await mkdir(path.dirname(path.join(staging, "package", file.path)), { recursive: true, mode: 0o700 });
        await writeFile(path.join(staging, "package", file.path), content, { flag: "wx", mode: 0o600 });
      }
      const archive = path.join(staging, "site.tar.gz");
      await createTar(
        { cwd: path.join(staging, "package"), file: archive, gzip: true, portable: true, mtime: new Date(0) },
        artifact.data.files.map((f) => f.path),
      );
      const content = await readFile(archive);
      return { content, sha256: digest(content), packageSha256: artifact.data.packageSha256 };
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
  private async required(scope: Scope, id: string) {
    const site = await this.repo.getDocument<Site>(scope, "website", id);
    if (!site) throw new DomainError("website_not_found", "website_not_found", 404);
    return site;
  }
}
