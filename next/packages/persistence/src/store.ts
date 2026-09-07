import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  approvalBindingSchema,
  mandateSchema,
  microsSchema,
  orderCreateSchema,
  orderPatchSchema,
  scopeSchema,
  setupSchema,
} from "../../contracts/src/index.ts";
import type {
  ApprovalBinding,
  EventRecord,
  Mandate,
  Order,
  OrderPatch,
  Reservation,
  Scope,
  SetupInput,
} from "../../contracts/src/index.ts";
import {
  assert,
  assertTransition,
  canonicalJson,
  parametersAllowed,
  sameScope,
  sha256,
} from "../../domain/src/index.ts";
import { crewSeed } from "../../domain/src/crew.ts";
import type {
  Approval,
  Area,
  AuthorizationInput,
  Budget,
  Document,
  Mutation,
  ReserveInput,
  SetupResult,
} from "./index.ts";
import { schema } from "./schema.ts";

type Row = Record<string, string | number | bigint | null>;
const now = () => new Date().toISOString();
const parse = <T>(value: unknown): T => JSON.parse(String(value)) as T;
const encode = (value: unknown) => JSON.stringify(value);
const redact = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(redact)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value).map(([k, v]) => [
            k,
            /password|secret|credential|authorization|accessToken|refreshToken/i.test(k) ? "[REDACTED]" : redact(v),
          ]),
        )
      : value;
export class Store {
  private db: DatabaseSync;
  private transactionDepth = 0;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    if (this.row("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'"))
      assert(this.row("SELECT version FROM schema_version")?.version === 1, "unsupported_schema");
    this.db.exec(schema);
    assert(this.row("SELECT version FROM schema_version")?.version === 1, "unsupported_schema");
  }
  private row(sql: string, ...args: (string | number | bigint | null)[]): Row | undefined {
    return this.db.prepare(sql).get(...args) as Row | undefined;
  }
  private rows(sql: string, ...args: (string | number | bigint | null)[]): Row[] {
    return this.db.prepare(sql).all(...args) as Row[];
  }
  private exec(sql: string, ...args: (string | number | bigint | null)[]): void {
    this.db.prepare(sql).run(...args);
  }
  private atomic<T>(fn: () => T): T {
    if (this.transactionDepth > 0) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.transactionDepth++;
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.transactionDepth--;
    }
  }
  health() {
    return {
      schemaVersion: 1,
      journalMode: String(this.row("PRAGMA journal_mode")?.journal_mode),
      foreignKeys: this.row("PRAGMA foreign_keys")?.foreign_keys === 1,
    };
  }
  close() {
    this.db.close();
  }
  private company(id: string) {
    const row = this.row("SELECT data FROM companies WHERE id=?", id);
    assert(row, "company_not_found", 404);
    return parse<SetupResult["company"]>(row.data);
  }
  private scope(value: Scope) {
    const s = scopeSchema.parse(value);
    assert(this.row("SELECT id FROM areas WHERE company_id=? AND id=?", s.companyId, s.areaId), "scope_denied", 403);
    for (const [kind, id] of [
      ["customer", s.customerId],
      ["project", s.projectId],
    ] as const) {
      if (id) {
        const r = this.row(
          "SELECT area_id,customer_id FROM documents WHERE company_id=? AND kind=? AND id=?",
          s.companyId,
          kind,
          id,
        );
        assert(
          r && r.area_id === s.areaId && (kind === "customer" || r.customer_id === (s.customerId ?? "")),
          "scope_denied",
          403,
        );
      }
    }
    return s;
  }
  private event(scope: Scope, type: string, aggregateId: string, revision: number, data: unknown = {}) {
    const event = {
      id: randomUUID(),
      scope,
      aggregateId,
      aggregateRevision: revision,
      type,
      occurredAt: now(),
      data: redact(data),
    };
    const result = this.db
      .prepare("INSERT INTO events(id,company_id,area_id,data) VALUES(?,?,?,?)")
      .run(event.id, scope.companyId, scope.areaId, encode(event));
    const complete = { ...event, sequence: Number(result.lastInsertRowid) };
    const previous = String(
      this.row("SELECT hash FROM audit WHERE company_id=? ORDER BY sequence DESC LIMIT 1", scope.companyId)?.hash ?? "",
    );
    const payload = canonicalJson(complete);
    const hash = sha256({ previousHash: previous, event: complete });
    this.exec(
      "INSERT INTO audit(company_id,previous_hash,hash,data) VALUES(?,?,?,?)",
      scope.companyId,
      previous,
      hash,
      payload,
    );
    this.exec(
      "INSERT INTO outbox(id,company_id,event_sequence,data) VALUES(?,?,?,?)",
      randomUUID(),
      scope.companyId,
      complete.sequence,
      encode(complete),
    );
    return complete;
  }
  setup(input: SetupInput): SetupResult {
    return this.atomic(() => {
      const valid = setupSchema.parse(input);
      assert(!this.row("SELECT id FROM companies"), "setup_already_complete");
      const company = { id: randomUUID(), name: valid.companyName, timezone: valid.timezone, createdAt: now() };
      this.exec("INSERT INTO companies VALUES(?,1,?)", company.id, encode(company));
      const areas: Area[] = [
        { id: randomUUID(), companyId: company.id, name: "Firma", visibility: "company" },
        { id: randomUUID(), companyId: company.id, name: "Privat", visibility: "private" },
      ];
      for (const area of areas) this.exec("INSERT INTO areas VALUES(?,?,?)", area.id, company.id, encode(area));
      const scope = { companyId: company.id, areaId: areas[0]!.id };
      const ceo = { id: randomUUID(), companyId: company.id, name: valid.ceoName, passwordHash: valid.passwordHash };
      this.writeDocument(scope, { kind: "identity", id: ceo.id, data: ceo, immutable: true });
      this.writeDocument(scope, { kind: "setup_progress", id: company.id, data: { version: 1, completedStep: 1 } });
      const employees = crewSeed.employees.map((seed) => ({ ...seed, id: randomUUID(), companyId: company.id }));
      for (const e of employees)
        this.exec("INSERT INTO employees VALUES(?,?,?,?)", e.id, company.id, e.seedKey, encode(e));
      const periodId = randomUUID();
      this.exec(
        "INSERT INTO budget_periods(id,company_id,limit_micros) VALUES(?,?,?)",
        periodId,
        company.id,
        BigInt(valid.budgetLimitUsdMicros),
      );
      this.event(scope, "company.setup", company.id, 1, { employeeCount: employees.length });
      return this.snapshot(company.id);
    });
  }
  setupState(): SetupResult | null {
    const row = this.row("SELECT id FROM companies");
    return row ? this.snapshot(String(row.id)) : null;
  }
  snapshot(companyId: string): SetupResult {
    const company = this.company(companyId);
    const ceo = this.getIdentity();
    assert(ceo?.companyId === companyId, "identity_missing");
    return {
      company,
      ceo: { id: ceo.id, name: ceo.name },
      areas: this.rows("SELECT data FROM areas WHERE company_id=? ORDER BY rowid", companyId).map((r) => parse(r.data)),
      employees: this.rows("SELECT data FROM employees WHERE company_id=? ORDER BY rowid", companyId).map((r) =>
        parse(r.data),
      ),
      periodId: String(this.row("SELECT id FROM budget_periods WHERE company_id=? AND active=1", companyId)?.id),
      setupProgress: parse<{ version: number; completedStep: number }>(
        this.row("SELECT data FROM documents WHERE company_id=? AND kind='setup_progress'", companyId)?.data,
      ),
    };
  }
  getIdentity(): { id: string; companyId: string; name: string; passwordHash: string } | null {
    const row = this.row("SELECT data FROM documents WHERE kind='identity'");
    return row ? parse(row.data) : null;
  }
  createArea(companyId: string, input: { name: string; visibility: "company" | "private" }): Area {
    return this.atomic(() => {
      this.company(companyId);
      assert(input.name.trim() && ["private", "company"].includes(input.visibility), "invalid_area", 400);
      const area = { ...input, id: randomUUID(), companyId };
      this.exec("INSERT INTO areas VALUES(?,?,?)", area.id, companyId, encode(area));
      this.event({ companyId, areaId: area.id }, "area.created", area.id, 1);
      return area;
    });
  }
  getOrder(scope: Scope, id: string): Order {
    this.scope(scope);
    const row = this.row("SELECT data FROM orders WHERE company_id=? AND id=?", scope.companyId, id);
    assert(row, "order_not_found", 404);
    const order = parse<Order>(row.data);
    assert(sameScope(scope, order.scope), "scope_denied", 403);
    return order;
  }
  listAllOrders(companyId: string): Order[] {
    this.company(companyId);
    return this.rows("SELECT data FROM orders WHERE company_id=? ORDER BY rowid", companyId).map((r) => parse(r.data));
  }
  listOrders(scope: Scope): Order[] {
    this.scope(scope);
    return this.rows(
      "SELECT data FROM orders WHERE company_id=? AND area_id=? AND customer_id=? AND project_id=? ORDER BY rowid",
      scope.companyId,
      scope.areaId,
      scope.customerId ?? "",
      scope.projectId ?? "",
    ).map((r) => parse(r.data));
  }
  createOrderAndTransact(
    scope: Scope,
    input: unknown,
    mutations: Mutation[],
    event: { type: string; aggregateId: string; data?: unknown },
    guard?: { mandateId: string; mandateVersion: number; now: string; maxActiveOrders: number },
  ): { order: Order; documents: Document<unknown>[] } {
    return this.atomic(() => {
      if (guard) {
        this.assertDispatchAllowed(scope.companyId);
        const key = `${guard.mandateId}:${guard.mandateVersion}`;
        const mandate = this.getDocument<Mandate>(scope, "mandate", key)?.data;
        assert(
          mandate &&
            !mandate.revokedAt &&
            !this.getDocument(scope, "mandate_revocation", key) &&
            Date.parse(mandate.expiresAt) > Date.parse(guard.now),
          "mandate_unavailable",
        );
        const orderInput = orderCreateSchema.parse(input);
        assert(BigInt(orderInput.budgetLimitUsdMicros) <= BigInt(mandate.maxCostUsdMicros), "mandate_budget_exceeded");
        assert(
          BigInt(orderInput.budgetLimitUsdMicros) <= BigInt(this.budget(scope.companyId).availableUsdMicros),
          "company_budget_exceeded",
        );
        const schedules = this.listDocuments<{ mandateId: string; activeOrderIds: string[] }>(scope, "schedule").filter(
          (d) => d.data.mandateId === guard.mandateId,
        );
        const activeIds = new Set(schedules.flatMap((d) => d.data.activeOrderIds));
        let active = 0;
        for (const id of activeIds) {
          if (!["completed", "cancelled", "failed"].includes(this.getOrder(scope, id).status)) active++;
        }
        assert(active < Math.min(3, guard.maxActiveOrders), "schedule_goal_limit");
      }
      const order = this.createOrder(scope, input);
      const documents = this.transact(scope, mutations, event);
      return { order, documents };
    });
  }
  createOrder(scope: Scope, input: unknown): Order {
    return this.atomic(() => {
      this.scope(scope);
      const v = orderCreateSchema.parse(input);
      const lead =
        v.leadEmployeeId ??
        String(
          this.row("SELECT id FROM employees WHERE company_id=? AND seed_key='chief_of_staff'", scope.companyId)?.id,
        );
      assert(
        this.row("SELECT id FROM employees WHERE company_id=? AND id=?", scope.companyId, lead),
        "invalid_lead",
        400,
      );
      const order: Order = {
        ...v,
        id: v.id ?? randomUUID(),
        scope,
        leadEmployeeId: lead,
        status: "inbox",
        revision: 1,
        planVersion: 0,
        acceptanceCriteria: v.acceptanceCriteria,
        createdAt: now(),
        updatedAt: now(),
      };
      this.exec(
        "INSERT INTO orders VALUES(?,?,?,?,?,?,?,?)",
        order.id,
        scope.companyId,
        scope.areaId,
        scope.customerId ?? "",
        scope.projectId ?? "",
        lead,
        1,
        encode(order),
      );
      this.event(scope, "order.created", order.id, 1);
      return order;
    });
  }
  commitPlan(
    scope: Scope,
    id: string,
    expectedRevision: number,
    input: { steps: string[]; acceptanceCriteria: string[] },
  ): Order {
    return this.atomic(() => {
      assert(
        input.steps.length > 0 &&
          input.acceptanceCriteria.length > 0 &&
          [...input.steps, ...input.acceptanceCriteria].every((v) => typeof v === "string" && v.trim().length > 0),
        "invalid_plan",
        400,
      );
      const current = this.getOrder(scope, id);
      assert(current.revision === expectedRevision, "revision_conflict");
      const version = current.planVersion + 1;
      const updated = this.updateOrder(scope, id, expectedRevision, {
        planVersion: version,
        acceptanceCriteria: input.acceptanceCriteria,
        ...(["inbox", "planning"].includes(current.status) ? { status: "ready" as const } : {}),
      });
      this.writeDocument(scope, {
        kind: "plan",
        id: randomUUID(),
        data: { orderId: id, version, ...input, createdAt: now() },
        immutable: true,
      });
      this.event(scope, "plan.committed", id, updated.revision, { planVersion: version });
      return updated;
    });
  }
  listCompanyDocuments<T>(companyId: string, kind: string): Document<T>[] {
    this.company(companyId);
    return this.rows("SELECT * FROM documents WHERE company_id=? AND kind=? ORDER BY rowid", companyId, kind).map(
      (r) => ({
        id: String(r.id),
        kind,
        revision: Number(r.revision),
        scope: {
          companyId,
          areaId: String(r.area_id),
          ...(r.customer_id ? { customerId: String(r.customer_id) } : {}),
          ...(r.project_id ? { projectId: String(r.project_id) } : {}),
        },
        data: parse<T>(r.data),
      }),
    );
  }
  eventsForCompany(companyId: string, after = 0, limit = 100): EventRecord[] {
    this.company(companyId);
    assert(
      Number.isSafeInteger(after) && after >= 0 && Number.isSafeInteger(limit) && limit > 0 && limit <= 1000,
      "invalid_cursor",
      400,
    );
    const latest = Number(
      this.row("SELECT COALESCE(MAX(sequence),0) AS last FROM events WHERE company_id=?", companyId)!.last,
    );
    assert(after <= latest, "cursor_stale", 409);
    return this.rows(
      "SELECT sequence,data FROM events WHERE company_id=? AND sequence>? ORDER BY sequence LIMIT ?",
      companyId,
      after,
      limit,
    ).map((r) => ({ ...parse<EventRecord>(r.data), sequence: Number(r.sequence) }));
  }
  decideApproval(scope: Scope, id: string, expectedRevision: number, decision: "approved" | "denied"): Approval {
    return this.atomic(() => {
      const pending = this.getDocument<{ binding: ApprovalBinding; status: string }>(scope, "approval-request", id);
      assert(pending, "approval_not_found", 404);
      assert(pending.revision === expectedRevision, "revision_conflict");
      assert(pending.data.status === "pending", "approval_not_pending");
      const approval = this.approve(scope, pending.data.binding, decision);
      const action = this.getDocument<import("../../contracts/src/index.ts").ToolAction>(
        scope,
        "action",
        pending.data.binding.actionId,
      );
      assert(action, "action_missing");
      this.writeDocument(scope, {
        kind: "action",
        id: action.id,
        data: { ...action.data, approvalId: approval.id, status: decision === "denied" ? "denied" : "authorized" },
        expectedRevision: action.revision,
      });
      this.writeDocument(scope, {
        kind: "approval-request",
        id,
        data: { ...pending.data, status: decision },
        expectedRevision: pending.revision,
      });
      return approval;
    });
  }
  updateOrder(scope: Scope, id: string, expectedRevision: number, patch: OrderPatch): Order {
    return this.atomic(() => {
      const v = orderPatchSchema.parse(patch);
      const current = this.getOrder(scope, id) as Order & {
        resumeState?: Order["status"];
        requiredReviewsPassed?: boolean;
        deliveryComplete?: boolean;
      };
      assert(current.revision === expectedRevision, "revision_conflict");
      if (v.planVersion !== undefined) assert(v.planVersion > current.planVersion, "plan_version_conflict");
      if (v.status) {
        assertTransition(current.status, v.status, current.resumeState);
        if (v.status === "ready") assert((v.planVersion ?? current.planVersion) > 0, "plan_required");
        if (v.status === "completed")
          assert(
            (v.requiredReviewsPassed ?? current.requiredReviewsPassed) &&
              (v.deliveryComplete ?? current.deliveryComplete),
            "completion_checks_required",
          );
      }
      const updated = {
        ...current,
        ...v,
        waitReason: v.waitReason === null ? undefined : (v.waitReason ?? current.waitReason),
        revision: current.revision + 1,
        updatedAt: now(),
      };
      if (v.status && ["paused", "blocked"].includes(v.status) && !["paused", "blocked"].includes(current.status))
        updated.resumeState = current.status;
      if (v.planVersion !== undefined) {
        updated.requiredReviewsPassed = false;
        updated.deliveryComplete = false;
      }
      this.exec(
        "UPDATE orders SET revision=?,data=? WHERE id=? AND company_id=? AND revision=?",
        updated.revision,
        encode(updated),
        id,
        scope.companyId,
        expectedRevision,
      );
      this.event(scope, "order.updated", id, updated.revision, { status: updated.status });
      return updated;
    });
  }
  changeLead(scope: Scope, id: string, expectedRevision: number, leadEmployeeId: string): Order {
    return this.atomic(() => {
      const current = this.getOrder(scope, id);
      assert(current.revision === expectedRevision, "revision_conflict");
      assert(
        this.row("SELECT id FROM employees WHERE company_id=? AND id=?", scope.companyId, leadEmployeeId),
        "invalid_lead",
        400,
      );
      const updated = { ...current, leadEmployeeId, revision: current.revision + 1, updatedAt: now() };
      this.exec(
        "UPDATE orders SET lead_employee_id=?,revision=?,data=? WHERE id=? AND revision=?",
        leadEmployeeId,
        updated.revision,
        encode(updated),
        id,
        expectedRevision,
      );
      this.event(scope, "order.lead_changed", id, updated.revision, {
        previousLead: current.leadEmployeeId,
        leadEmployeeId,
      });
      return updated;
    });
  }
  getDocument<T>(scope: Scope, kind: string, id: string): Document<T> | null {
    this.scope(scope);
    const row = this.row("SELECT * FROM documents WHERE company_id=? AND kind=? AND id=?", scope.companyId, kind, id);
    if (!row) return null;
    assert(
      row.area_id === scope.areaId &&
        row.customer_id === (scope.customerId ?? "") &&
        row.project_id === (scope.projectId ?? ""),
      "scope_denied",
      403,
    );
    return { id, scope, kind, revision: Number(row.revision), data: parse<T>(row.data) };
  }
  listDocuments<T>(scope: Scope, kind: string): Document<T>[] {
    this.scope(scope);
    return this.rows(
      "SELECT id,revision,data FROM documents WHERE company_id=? AND area_id=? AND customer_id=? AND project_id=? AND kind=? ORDER BY rowid",
      scope.companyId,
      scope.areaId,
      scope.customerId ?? "",
      scope.projectId ?? "",
      kind,
    ).map((r) => ({ id: String(r.id), scope, kind, revision: Number(r.revision), data: parse<T>(r.data) }));
  }
  private writeDocument<T>(scope: Scope, mutation: Mutation): Document<T> {
    this.scope(scope);
    assert(mutation.kind.length > 0 && mutation.id.length > 0, "invalid_document", 400);
    canonicalJson(mutation.data);
    const prior = this.getDocument(scope, mutation.kind, mutation.id);
    assert(
      !prior ||
        (!mutation.immutable &&
          !this.row(
            "SELECT id FROM document_seals WHERE company_id=? AND kind=? AND id=?",
            scope.companyId,
            mutation.kind,
            mutation.id,
          )),
      "immutable_document",
    );
    assert(
      prior
        ? mutation.expectedRevision === prior.revision
        : mutation.expectedRevision === undefined || mutation.expectedRevision === 0,
      "revision_conflict",
    );
    const revision = (prior?.revision ?? 0) + 1;
    this.exec(
      "INSERT INTO documents VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(company_id,kind,id) DO UPDATE SET revision=excluded.revision,data=excluded.data",
      scope.companyId,
      scope.areaId,
      mutation.kind,
      mutation.id,
      scope.customerId ?? "",
      scope.projectId ?? "",
      revision,
      encode(mutation.data),
    );
    if (mutation.immutable)
      this.exec("INSERT INTO document_seals VALUES(?,?,?)", scope.companyId, mutation.kind, mutation.id);
    return { id: mutation.id, scope, kind: mutation.kind, revision, data: mutation.data as T };
  }
  putDocument<T>(
    scope: Scope,
    kind: string,
    id: string,
    data: T,
    options: { expectedRevision?: number; immutable?: boolean; eventType?: string } = {},
  ): Document<T> {
    return this.atomic(() => {
      const doc = this.writeDocument<T>(scope, { kind, id, data, ...options });
      this.event(scope, options.eventType ?? `${kind}.saved`, id, doc.revision);
      return doc;
    });
  }
  transact(
    scope: Scope,
    mutations: Mutation[],
    event: { type: string; aggregateId: string; data?: unknown },
  ): Document<unknown>[] {
    return this.atomic(() => {
      assert(mutations.length > 0 && mutations.length <= 100, "invalid_transaction", 400);
      const docs = mutations.map((m) => this.writeDocument(scope, m));
      this.event(scope, event.type, event.aggregateId, Math.max(...docs.map((d) => d.revision)), event.data);
      return docs;
    });
  }
  authorizeAndTransact(
    scope: Scope,
    input: AuthorizationInput,
    mutations: Mutation[],
    event: { type: string; aggregateId: string; data?: unknown },
  ): Document<unknown>[] {
    return this.atomic(() => {
      this.assertAuthorized(scope, input);
      assert(mutations.length > 0 && mutations.length <= 100, "invalid_transaction", 400);
      const docs = mutations.map((m) => this.writeDocument(scope, m));
      this.event(scope, event.type, event.aggregateId, Math.max(...docs.map((d) => d.revision)), event.data);
      return docs;
    });
  }
  createMandate(input: Mandate): Mandate {
    return this.atomic(() => {
      const mandate = mandateSchema.parse(input) as Mandate;
      assert(Date.parse(mandate.expiresAt) > Date.now(), "mandate_expired");
      this.writeDocument(mandate.scope, {
        kind: "mandate",
        id: `${mandate.id}:${mandate.version}`,
        data: mandate,
        immutable: true,
      });
      this.event(mandate.scope, "mandate.created", mandate.id, mandate.version);
      return mandate;
    });
  }
  revokeMandate(scope: Scope, id: string, version: number): void {
    this.atomic(() => {
      assert(this.getDocument(scope, "mandate", `${id}:${version}`), "mandate_not_found", 404);
      const prior = this.getDocument(scope, "mandate_revocation", `${id}:${version}`);
      if (prior) return;
      this.writeDocument(scope, {
        kind: "mandate_revocation",
        id: `${id}:${version}`,
        data: { revokedAt: now() },
        immutable: true,
      });
      this.event(scope, "mandate.revoked", id, version);
    });
  }
  approve(scope: Scope, input: ApprovalBinding, decision: "approved" | "denied"): Approval {
    return this.atomic(() => {
      const binding = approvalBindingSchema.parse(input);
      assert(binding.companyId === scope.companyId, "scope_denied", 403);
      this.getOrder(scope, binding.orderId);
      const pending = this.getDocument<import("../../contracts/src/index.ts").ToolAction>(
        scope,
        "action",
        binding.actionId,
      )?.data;
      assert(
        pending &&
          pending.orderId === binding.orderId &&
          pending.argumentsSha256 === binding.argumentsSha256 &&
          sha256(pending.args) === binding.argumentsSha256 &&
          pending.mandateId === binding.mandateId &&
          pending.mandateVersion === binding.mandateVersion &&
          ["proposed", "authorized"].includes(pending.status),
        "approval_action_mismatch",
        403,
      );
      assert(Date.parse(binding.expiresAt) > Date.now(), "approval_expired");
      assert(["approved", "denied"].includes(decision), "invalid_approval", 400);
      const mandate = this.getDocument<Mandate>(scope, "mandate", `${binding.mandateId}:${binding.mandateVersion}`);
      assert(mandate, "mandate_not_found", 404);
      assert(
        !this.getDocument(scope, "mandate_revocation", `${binding.mandateId}:${binding.mandateVersion}`),
        "mandate_revoked",
      );
      const result: Approval = { id: randomUUID(), binding, decision, decidedAt: now() };
      this.writeDocument(scope, { kind: "approval", id: result.id, data: result, immutable: true });
      this.event(scope, "approval.decided", result.id, 1, { decision, actionId: binding.actionId });
      return result;
    });
  }
  assertDispatchAllowed(companyId: string): void {
    this.company(companyId);
    const row = this.row(
      "SELECT data FROM documents WHERE company_id=? AND kind='recovery-state' AND id=?",
      companyId,
      companyId,
    );
    if (row) assert(parse<{ dispatchPaused?: boolean }>(row.data).dispatchPaused !== true, "recovery_dispatch_paused");
  }
  assertAuthorized(scope: Scope, input: AuthorizationInput): void {
    this.assertDispatchAllowed(scope.companyId);
    this.scope(scope);
    const { action } = input;
    assert(sameScope(scope, action.scope), "scope_denied", 403);
    const executableOrder = this.getOrder(scope, action.orderId);
    assert(!["paused", "cancelled", "completed", "failed"].includes(executableOrder.status), "order_not_executable");
    assert(action.argumentsSha256 === sha256(action.args), "arguments_hash_mismatch", 403);
    const key = `${action.mandateId}:${action.mandateVersion}`;
    const mandate = this.getDocument<Mandate>(scope, "mandate", key)?.data;
    assert(mandate, "mandate_not_found", 403);
    assert(!mandate.revokedAt && !this.getDocument(scope, "mandate_revocation", key), "mandate_revoked", 403);
    assert(Date.parse(mandate.expiresAt) > Date.now(), "mandate_expired", 403);
    assert(
      mandate.allowedToolIds.includes(action.toolId) && mandate.targetIds.includes(input.targetId),
      "mandate_denied",
      403,
    );
    assert(parametersAllowed(action.args, mandate.parameterConstraints), "parameters_denied", 403);
    assert(
      Number.isSafeInteger(input.attempt ?? 1) &&
        (input.attempt ?? 1) > 0 &&
        (input.attempt ?? 1) <= mandate.maxAttempts,
      "attempt_limit",
      403,
    );
    assert(
      Number.isSafeInteger(input.durationSeconds ?? 1) &&
        (input.durationSeconds ?? 1) > 0 &&
        (input.durationSeconds ?? 1) <= mandate.maxDurationSeconds,
      "duration_limit",
      403,
    );
    assert(
      BigInt(microsSchema.parse(input.costUsdMicros ?? "0")) <= BigInt(mandate.maxCostUsdMicros),
      "mandate_budget_exceeded",
      403,
    );
    if (
      !action.approvalId &&
      !input.requireApproval &&
      input.effect &&
      ["read", "workspace_write", "external_draft", "external_change"].includes(input.effect)
    )
      return;
    if (
      !action.approvalId &&
      !input.requireApproval &&
      input.effect === "external_send" &&
      action.toolId === "sevdesk.reminder.send" &&
      input.routineRuleId &&
      input.routineRuleVersion
    ) {
      const rule = this.getDocument<{
        version: number;
        approvedByCeo: boolean;
        enabled: boolean;
        targetIds: string[];
        recipients: string[];
        invoiceIds: string[];
        feesMinor: string;
      }>(scope, "reminder-rule", `${input.routineRuleId}:${input.routineRuleVersion}`)?.data;
      const args = action.args as Record<string, unknown>;
      assert(args && typeof args === "object" && !Array.isArray(args), "reminder_rule_denied", 403);
      assert(
        rule &&
          !this.getDocument(scope, "reminder-rule-revocation", `${input.routineRuleId}:${input.routineRuleVersion}`) &&
          rule.version === input.routineRuleVersion &&
          rule.approvedByCeo === true &&
          rule.enabled === true &&
          rule.feesMinor === "0" &&
          Array.isArray(rule.targetIds) &&
          rule.targetIds.includes(input.targetId) &&
          Array.isArray(rule.recipients) &&
          typeof args.to === "string" &&
          rule.recipients.includes(args.to) &&
          Array.isArray(rule.invoiceIds) &&
          typeof args.invoiceId === "string" &&
          rule.invoiceIds.includes(args.invoiceId) &&
          args.ruleId === input.routineRuleId &&
          args.ruleVersion === input.routineRuleVersion,
        "reminder_rule_denied",
        403,
      );
      return;
    }
    const approval = action.approvalId
      ? this.getDocument<Approval>(scope, "approval", action.approvalId)?.data
      : undefined;
    assert(approval && approval.decision === "approved", "approval_required", 403);
    const expected: ApprovalBinding = {
      companyId: scope.companyId,
      orderId: action.orderId,
      mandateId: action.mandateId,
      mandateVersion: action.mandateVersion,
      actionId: action.id,
      targetId: input.targetId,
      argumentsSha256: action.argumentsSha256,
      ...(input.artifactVersionId ? { artifactVersionId: input.artifactVersionId } : {}),
      expiresAt: approval.binding.expiresAt,
    };
    assert(sha256(expected) === sha256(approval.binding), "approval_binding_mismatch", 403);
    assert(Date.parse(approval.binding.expiresAt) > Date.now(), "approval_expired", 403);
  }
  private reservationRow(id: string): Row | undefined {
    return this.row(
      "SELECT id,company_id,period_id,order_id,CAST(reserved_micros AS TEXT) AS reserved_micros,CAST(settled_micros AS TEXT) AS settled_micros,state,data FROM reservations WHERE id=?",
      id,
    );
  }
  private reservation(row: Row): Reservation {
    return {
      ...parse<Reservation>(row.data),
      reservedUsdMicros: String(row.reserved_micros),
      ...(row.settled_micros !== null ? { settledUsdMicros: String(row.settled_micros) } : {}),
      state: row.state as Reservation["state"],
    };
  }
  private totals(companyId: string, orderId?: string, periodId?: string) {
    const rows = this.rows(
      `SELECT CAST(reserved_micros AS TEXT) AS reserved_micros,CAST(settled_micros AS TEXT) AS settled_micros,state,period_id FROM reservations WHERE company_id=?${orderId ? " AND order_id=?" : ""}`,
      ...(orderId ? [companyId, orderId] : [companyId]),
    );
    let spent = 0n,
      reserved = 0n,
      unreconciled = 0n;
    for (const row of rows) {
      if (row.state === "settled" && (!periodId || row.period_id === periodId))
        spent += BigInt(String(row.settled_micros));
      if (row.state === "held" || row.state === "unreconciled") reserved += BigInt(String(row.reserved_micros));
      if (row.state === "unreconciled") unreconciled += BigInt(String(row.reserved_micros));
    }
    return { spent, reserved, unreconciled };
  }
  reserveAndTransact(
    scope: Scope,
    input: ReserveInput,
    mutations: Mutation[],
    event: { type: string; aggregateId: string; data?: unknown },
  ): Document<unknown>[] {
    return this.atomic(() => {
      this.assertDispatchAllowed(scope.companyId);
      this.reserve(scope, input);
      return this.transact(scope, mutations, event);
    });
  }
  settleAndTransact(
    scope: Scope,
    input: { reservationId: string; actualMicros?: string },
    mutations: Mutation[],
    event: { type: string; aggregateId: string; data?: unknown },
  ): Document<unknown>[] {
    return this.atomic(() => {
      if (input.actualMicros === undefined) this.markUnreconciled(scope, input.reservationId);
      else this.settle(scope, input.reservationId, input.actualMicros);
      return this.transact(scope, mutations, event);
    });
  }
  reserve(scope: Scope, input: ReserveInput): Reservation {
    return this.atomic(() => {
      const order = this.getOrder(scope, input.orderId);
      const amount = BigInt(microsSchema.parse(input.amountUsdMicros));
      const existing = this.reservationRow(input.id);
      if (existing) {
        assert(existing.company_id === scope.companyId && existing.order_id === input.orderId, "scope_denied", 403);
        const old = this.reservation(existing);
        assert(
          old.periodId === input.periodId &&
            old.reservedUsdMicros === input.amountUsdMicros &&
            old.modelTurnId === input.modelTurnId &&
            old.actionId === input.actionId &&
            old.mandateId === input.mandateId &&
            old.mandateVersion === input.mandateVersion,
          "reservation_conflict",
        );
        return old;
      }
      this.rollBudget(scope.companyId);
      const configScope = { companyId: scope.companyId, areaId: this.snapshot(scope.companyId).areas[0]!.id };
      const periodConfig = this.getDocument<{ startsAt?: string; endsAt?: string }>(
        configScope,
        "budget_config",
        scope.companyId,
      )?.data;
      if (periodConfig?.startsAt)
        assert(
          Date.now() >= Date.parse(periodConfig.startsAt) && Date.now() < Date.parse(periodConfig.endsAt!),
          "budget_period_inactive",
        );
      const period = this.row(
        "SELECT CAST(limit_micros AS TEXT) AS limit_micros FROM budget_periods WHERE company_id=? AND id=? AND active=1",
        scope.companyId,
        input.periodId,
      );
      assert(period, "budget_period_not_found", 404);
      const companyTotal = this.totals(scope.companyId, undefined, input.periodId),
        orderTotal = this.totals(scope.companyId, order.id);
      assert(
        companyTotal.spent + companyTotal.reserved + amount <= BigInt(String(period.limit_micros)),
        "company_budget_exceeded",
      );
      assert(
        orderTotal.spent + orderTotal.reserved + amount <= BigInt(order.budgetLimitUsdMicros),
        "order_budget_exceeded",
      );
      if (input.mandateId || input.mandateVersion) {
        assert(input.mandateId && Number.isSafeInteger(input.mandateVersion), "mandate_missing");
        const key = input.mandateId + ":" + input.mandateVersion;
        const mandate = this.getDocument<Mandate>(scope, "mandate", key)?.data;
        assert(
          mandate &&
            !mandate.revokedAt &&
            Date.parse(mandate.expiresAt) > Date.now() &&
            !this.getDocument(scope, "mandate_revocation", key),
          "mandate_unavailable",
        );
        let committed = 0n;
        for (const row of this.rows(
          "SELECT id FROM reservations WHERE company_id=? AND json_extract(data,'$.mandateId')=? AND json_extract(data,'$.mandateVersion')=?",
          scope.companyId,
          input.mandateId,
          input.mandateVersion!,
        )) {
          const r = this.reservation(this.reservationRow(String(row.id))!);
          if (r.state === "settled") committed += BigInt(r.settledUsdMicros!);
          else if (r.state === "held" || r.state === "unreconciled") committed += BigInt(r.reservedUsdMicros);
        }
        assert(committed + amount <= BigInt(mandate.maxCostUsdMicros), "mandate_budget_exceeded");
      }
      const result: Reservation = {
        id: input.id,
        periodId: input.periodId,
        orderId: input.orderId,
        ...(input.mandateId ? { mandateId: input.mandateId, mandateVersion: input.mandateVersion } : {}),
        ...(input.modelTurnId ? { modelTurnId: input.modelTurnId } : {}),
        ...(input.actionId ? { actionId: input.actionId } : {}),
        reservedUsdMicros: input.amountUsdMicros,
        state: "held",
      };
      this.exec(
        "INSERT INTO reservations VALUES(?,?,?,?,?,NULL,'held',?)",
        input.id,
        scope.companyId,
        input.periodId,
        input.orderId,
        amount,
        encode(result),
      );
      this.event(scope, "budget.reserved", input.id, 1, {
        orderId: order.id,
        reservedUsdMicros: input.amountUsdMicros,
      });
      return result;
    });
  }
  settle(scope: Scope, id: string, actualMicros: string): Reservation {
    return this.atomic(() => {
      const actual = BigInt(microsSchema.parse(actualMicros));
      const row = this.reservationRow(id);
      assert(row, "reservation_not_found", 404);
      assert(row.company_id === scope.companyId, "scope_denied", 403);
      this.getOrder(scope, String(row.order_id));
      if (row.state === "settled") {
        assert(String(row.settled_micros) === actualMicros, "settlement_conflict");
        return this.reservation(row);
      }
      assert(row.state === "held" || row.state === "unreconciled", "reservation_not_held");
      this.exec("UPDATE reservations SET settled_micros=?,state='settled' WHERE id=?", actual, id);
      this.event(scope, "budget.settled", id, 2, { actualUsdMicros: actualMicros });
      return this.reservation(this.reservationRow(id)!);
    });
  }
  markUnreconciled(scope: Scope, id: string): Reservation {
    return this.changeReservation(scope, id, "unreconciled");
  }
  releaseReservation(scope: Scope, id: string): Reservation {
    return this.changeReservation(scope, id, "released");
  }
  private changeReservation(scope: Scope, id: string, state: "unreconciled" | "released"): Reservation {
    return this.atomic(() => {
      const row = this.reservationRow(id);
      assert(row, "reservation_not_found", 404);
      assert(row.company_id === scope.companyId, "scope_denied", 403);
      this.getOrder(scope, String(row.order_id));
      if (row.state === state) return this.reservation(row);
      assert(row.state === "held", "reservation_not_held");
      this.exec("UPDATE reservations SET state=? WHERE id=?", state, id);
      this.event(scope, `budget.${state}`, id, 2);
      return this.reservation(this.reservationRow(id)!);
    });
  }
  private rollBudget(companyId: string, at = Date.now()): void {
    this.atomic(() => {
      const company = this.snapshot(companyId);
      const scope = { companyId, areaId: company.areas[0]!.id };
      const doc = this.getDocument<{
        limitUsdMicros: string;
        startsAt?: string;
        endsAt?: string;
        renewal?: "none" | "fixed_duration";
      }>(scope, "budget_config", companyId);
      if (
        !doc?.data.startsAt ||
        !doc.data.endsAt ||
        doc.data.renewal !== "fixed_duration" ||
        at < Date.parse(doc.data.endsAt)
      )
        return;
      const width = Date.parse(doc.data.endsAt) - Date.parse(doc.data.startsAt);
      assert(width > 0, "invalid_budget_period", 400);
      const steps = Math.floor((at - Date.parse(doc.data.startsAt)) / width);
      const startsAt = new Date(Date.parse(doc.data.startsAt) + steps * width).toISOString();
      const endsAt = new Date(Date.parse(startsAt) + width).toISOString();
      const old = this.row(
        "SELECT id,CAST(limit_micros AS TEXT) AS limit_micros FROM budget_periods WHERE company_id=? AND active=1",
        companyId,
      )!;
      const totals = this.totals(companyId, undefined, String(old.id));
      this.writeDocument(scope, {
        kind: "budget-period",
        id: String(old.id),
        data: { ...doc.data, spentUsdMicros: totals.spent.toString(), closedAt: new Date(at).toISOString() },
        immutable: true,
      });
      this.exec("UPDATE budget_periods SET active=-rowid WHERE company_id=? AND active=1", companyId);
      const id = randomUUID();
      this.exec(
        "INSERT INTO budget_periods(id,company_id,limit_micros) VALUES(?,?,?)",
        id,
        companyId,
        BigInt(String(old.limit_micros)),
      );
      this.writeDocument(scope, {
        kind: "budget_config",
        id: companyId,
        data: { ...doc.data, startsAt, endsAt },
        expectedRevision: doc.revision,
      });
      this.event(scope, "budget.period_renewed", id, 1, {
        priorPeriodId: String(old.id),
        startsAt,
        endsAt,
        carriedReservationsUsdMicros: totals.reserved.toString(),
      });
    });
  }
  setBudget(
    companyId: string,
    input: { limitUsdMicros: string; startsAt?: string; endsAt?: string; renewal?: "none" | "fixed_duration" },
  ): Budget {
    return this.atomic(() => {
      this.company(companyId);
      this.rollBudget(companyId);
      const limit = BigInt(microsSchema.parse(input.limitUsdMicros));
      const period = this.row("SELECT id FROM budget_periods WHERE company_id=? AND active=1", companyId)!;
      const totals = this.totals(companyId, undefined, String(period.id));
      assert(limit >= totals.spent + totals.reserved, "budget_below_committed");
      const scope = { companyId, areaId: this.snapshot(companyId).areas[0]!.id };
      const prior = this.getDocument<{ startsAt?: string; endsAt?: string; renewal?: "none" | "fixed_duration" }>(
        scope,
        "budget_config",
        companyId,
      );
      const config = { ...prior?.data, ...input };
      if (config.startsAt || config.endsAt)
        assert(
          config.startsAt &&
            config.endsAt &&
            Number.isFinite(Date.parse(config.startsAt)) &&
            Date.parse(config.startsAt) < Date.parse(config.endsAt),
          "invalid_budget_period",
          400,
        );
      assert(!config.renewal || ["none", "fixed_duration"].includes(config.renewal), "invalid_budget_renewal", 400);
      if (config.renewal === "fixed_duration") assert(config.startsAt && config.endsAt, "invalid_budget_period", 400);
      this.exec("UPDATE budget_periods SET limit_micros=? WHERE company_id=? AND active=1", limit, companyId);
      this.writeDocument(scope, {
        kind: "budget_config",
        id: companyId,
        data: config,
        expectedRevision: prior?.revision,
      });
      this.event(scope, "budget.updated", companyId, (prior?.revision ?? 0) + 1, {
        limitUsdMicros: input.limitUsdMicros,
      });
      return this.budget(companyId);
    });
  }
  budget(companyId: string): Budget {
    this.company(companyId);
    this.rollBudget(companyId);
    const period = this.row(
      "SELECT id,CAST(limit_micros AS TEXT) AS limit_micros FROM budget_periods WHERE company_id=? AND active=1",
      companyId,
    );
    assert(period, "budget_period_not_found", 404);
    const total = this.totals(companyId, undefined, String(period.id)),
      limit = BigInt(String(period.limit_micros));
    const config = this.getDocument<{ startsAt?: string; endsAt?: string; renewal?: "none" | "fixed_duration" }>(
      { companyId, areaId: this.snapshot(companyId).areas[0]!.id },
      "budget_config",
      companyId,
    )?.data;
    const inactive =
      !!config?.startsAt && (Date.now() < Date.parse(config.startsAt) || Date.now() >= Date.parse(config.endsAt!));
    return {
      periodId: String(period.id),
      limitUsdMicros: limit.toString(),
      spentUsdMicros: total.spent.toString(),
      reservedUsdMicros: total.reserved.toString(),
      unreconciledUsdMicros: total.unreconciled.toString(),
      availableUsdMicros:
        inactive || total.spent + total.reserved >= limit ? "0" : (limit - total.spent - total.reserved).toString(),
      startsAt: config?.startsAt,
      endsAt: config?.endsAt,
      renewal: config?.renewal ?? "none",
      periodActive: !inactive,
      reservations: this.rows("SELECT id FROM reservations WHERE company_id=?", companyId).map((row) =>
        this.reservation(this.reservationRow(String(row.id))!),
      ),
    };
  }
  events(scope: Scope, after = 0, limit = 100): EventRecord[] {
    this.scope(scope);
    assert(
      Number.isSafeInteger(after) && after >= 0 && Number.isSafeInteger(limit) && limit > 0 && limit <= 1000,
      "invalid_cursor",
      400,
    );
    return this.rows(
      "SELECT sequence,data FROM events WHERE company_id=? AND area_id=? AND sequence>? AND COALESCE(json_extract(data,'$.scope.customerId'),'')=? AND COALESCE(json_extract(data,'$.scope.projectId'),'')=? ORDER BY sequence LIMIT ?",
      scope.companyId,
      scope.areaId,
      after,
      scope.customerId ?? "",
      scope.projectId ?? "",
      limit,
    )
      .map((row) => ({ ...parse<EventRecord>(row.data), sequence: Number(row.sequence) }))
      .filter((event) => sameScope(event.scope, scope));
  }
  verifyAudit(companyId: string): boolean {
    this.company(companyId);
    let previous = "";
    for (const row of this.rows(
      "SELECT previous_hash,hash,data FROM audit WHERE company_id=? ORDER BY sequence",
      companyId,
    )) {
      if (row.previous_hash !== previous || sha256({ previousHash: previous, event: parse(row.data) }) !== row.hash)
        return false;
      previous = String(row.hash);
    }
    return true;
  }
  pendingOutbox(companyId: string) {
    this.company(companyId);
    return this.rows(
      "SELECT id,event_sequence,data FROM outbox WHERE company_id=? AND state='pending' ORDER BY event_sequence",
      companyId,
    ).map((r) => ({ id: String(r.id), eventSequence: Number(r.event_sequence), data: parse<EventRecord>(r.data) }));
  }
  acknowledgeOutbox(companyId: string, id: string): void {
    this.atomic(() => {
      this.company(companyId);
      assert(this.row("SELECT id FROM outbox WHERE company_id=? AND id=?", companyId, id), "outbox_not_found", 404);
      this.exec("UPDATE outbox SET state='acknowledged' WHERE company_id=? AND id=?", companyId, id);
    });
  }
  backup(path: string): void {
    assert(path !== ":memory:", "invalid_backup_path", 400);
    this.db.prepare("VACUUM INTO ?").run(path);
  }
}
