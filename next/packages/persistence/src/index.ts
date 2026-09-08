import { Worker } from "node:worker_threads";
import { DomainError } from "../../domain/src/index.ts";
import type {
  ApprovalBinding,
  CreateOrderInput,
  EventRecord,
  Json,
  Mandate,
  Order,
  OrderPatch,
  Reservation,
  Scope,
  SetupInput,
  ToolAction,
} from "../../contracts/src/index.ts";
export interface Company {
  id: string;
  name: string;
  timezone: string;
  createdAt: string;
}
export interface Employee {
  id: string;
  companyId: string;
  seedKey: string;
  displayName: string;
  role: string;
  rank: string;
  appearance: string;
  persona: string;
  modelOverride: null;
  permissionsFromPersona: false;
}
export interface Area {
  id: string;
  companyId: string;
  name: string;
  visibility: "company" | "private";
}
export interface SetupResult {
  company: Company;
  ceo: { id: string; name: string };
  areas: Area[];
  employees: Employee[];
  periodId: string;
  setupProgress: { version: number; completedStep: number };
}
export interface Document<T = Json> {
  id: string;
  scope: Scope;
  kind: string;
  revision: number;
  data: T;
}
export interface Mutation {
  kind: string;
  id: string;
  data: unknown;
  expectedRevision?: number;
  immutable?: boolean;
}
export interface Budget {
  startsAt?: string;
  endsAt?: string;
  renewal?: "none" | "fixed_duration";
  periodActive?: boolean;
  periodId: string;
  limitUsdMicros: string;
  spentUsdMicros: string;
  reservedUsdMicros: string;
  unreconciledUsdMicros: string;
  availableUsdMicros: string;
  reservations: Reservation[];
}
export interface ReserveInput {
  mandateId?: string;
  mandateVersion?: number;
  id: string;
  periodId: string;
  orderId: string;
  amountUsdMicros: string;
  modelTurnId?: string;
  actionId?: string;
}
export interface AuthorizationInput {
  requireApproval?: boolean;
  routineRuleId?: string;
  routineRuleVersion?: number;
  durationSeconds?: number;
  effect?: import("../../contracts/src/index.ts").EffectClass;
  action: ToolAction;
  targetId: string;
  artifactVersionId?: string;
  costUsdMicros?: string;
  attempt?: number;
}
export interface Approval {
  id: string;
  binding: ApprovalBinding;
  decision: "approved" | "denied";
  decidedAt: string;
}
export class Repository {
  private worker: Worker;
  private sequence = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private closed = false;
  private constructor(path: string) {
    this.worker = new Worker(
      new URL(import.meta.url.endsWith(".ts") ? "./worker.ts" : "./worker.js", import.meta.url),
      { workerData: { path } },
    );
    this.worker.on(
      "message",
      (message: { id: number; result?: unknown; error?: { code: string; message: string; status: number } }) => {
        const p = this.pending.get(message.id);
        if (!p) return;
        this.pending.delete(message.id);
        if (message.error) p.reject(new DomainError(message.error.code, message.error.message, message.error.status));
        else p.resolve(message.result);
      },
    );
    this.worker.on("error", (e) => {
      for (const p of this.pending.values()) p.reject(e instanceof Error ? e : new Error(String(e)));
      this.pending.clear();
    });
    this.worker.on("exit", (code) => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error(`Database worker exited (${code})`));
      this.pending.clear();
    });
  }
  static async open(path: string): Promise<Repository> {
    const repo = new Repository(path);
    await repo.call("health", []);
    return repo;
  }
  private call<T>(method: string, args: unknown[]): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Repository is closed"));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker.postMessage({ id, method, args });
    });
  }
  async close(): Promise<void> {
    if (this.closed) return;
    await this.call("close", []);
    await this.worker.terminate();
    this.closed = true;
  }
  assertDispatchAllowed(companyId: string): Promise<void> {
    return this.call("assertDispatchAllowed", [companyId]);
  }
  health(): Promise<{ schemaVersion: number; journalMode: string; foreignKeys: boolean }> {
    return this.call("health", []);
  }
  setup(input: SetupInput): Promise<SetupResult> {
    return this.call("setup", [input]);
  }
  setupState(): Promise<SetupResult | null> {
    return this.call("setupState", []);
  }
  snapshot(companyId: string): Promise<SetupResult> {
    return this.call("snapshot", [companyId]);
  }
  getIdentity(): Promise<{ id: string; companyId: string; name: string; passwordHash: string } | null> {
    return this.call("getIdentity", []);
  }
  createArea(companyId: string, input: { name: string; visibility: "company" | "private" }): Promise<Area> {
    return this.call("createArea", [companyId, input]);
  }
  createOrderAndTransact(
    scope: Scope,
    input: CreateOrderInput,
    mutations: Mutation[],
    event: { type: string; aggregateId: string; data?: unknown },
    guard?: { mandateId: string; mandateVersion: number; now: string; maxActiveOrders: number },
  ): Promise<{ order: Order; documents: Document<unknown>[] }> {
    return this.call("createOrderAndTransact", [scope, input, mutations, event, guard]);
  }
  createOrder(scope: Scope, input: CreateOrderInput): Promise<Order> {
    return this.call("createOrder", [scope, input]);
  }
  getOrder(scope: Scope, id: string): Promise<Order> {
    return this.call("getOrder", [scope, id]);
  }
  listAllOrders(companyId: string): Promise<Order[]> {
    return this.call("listAllOrders", [companyId]);
  }
  setBudget(
    companyId: string,
    input: { limitUsdMicros: string; startsAt?: string; endsAt?: string; renewal?: "none" | "fixed_duration" },
  ): Promise<Budget> {
    return this.call("setBudget", [companyId, input]);
  }
  listOrders(scope: Scope): Promise<Order[]> {
    return this.call("listOrders", [scope]);
  }
  commitPlan(
    scope: Scope,
    id: string,
    expectedRevision: number,
    input: { steps: string[]; acceptanceCriteria: string[] },
  ): Promise<Order> {
    return this.call("commitPlan", [scope, id, expectedRevision, input]);
  }
  listCompanyDocuments<T = Json>(companyId: string, kind: string): Promise<Document<T>[]> {
    return this.call("listCompanyDocuments", [companyId, kind]);
  }
  eventsForCompany(companyId: string, after = 0, limit = 100): Promise<EventRecord[]> {
    return this.call("eventsForCompany", [companyId, after, limit]);
  }
  decideApproval(
    scope: Scope,
    id: string,
    expectedRevision: number,
    decision: "approved" | "denied",
  ): Promise<Approval> {
    return this.call("decideApproval", [scope, id, expectedRevision, decision]);
  }
  updateOrder(scope: Scope, id: string, expectedRevision: number, patch: OrderPatch): Promise<Order> {
    return this.call("updateOrder", [scope, id, expectedRevision, patch]);
  }
  changeLead(scope: Scope, id: string, expectedRevision: number, leadEmployeeId: string): Promise<Order> {
    return this.call("changeLead", [scope, id, expectedRevision, leadEmployeeId]);
  }
  getDocument<T = Json>(scope: Scope, kind: string, id: string): Promise<Document<T> | null> {
    return this.call("getDocument", [scope, kind, id]);
  }
  listDocuments<T = Json>(scope: Scope, kind: string): Promise<Document<T>[]> {
    return this.call("listDocuments", [scope, kind]);
  }
  putDocument<T>(
    scope: Scope,
    kind: string,
    id: string,
    data: T,
    options: { expectedRevision?: number; immutable?: boolean; eventType?: string } = {},
  ): Promise<Document<T>> {
    return this.call("putDocument", [scope, kind, id, data, options]);
  }
  transact(
    scope: Scope,
    mutations: Mutation[],
    event: { type: string; aggregateId: string; data?: unknown },
  ): Promise<Document<unknown>[]> {
    return this.call("transact", [scope, mutations, event]);
  }
  transactCatalog(scope: Scope, mutations: Mutation[]): Promise<void> {
    return this.call("transactCatalog", [scope, mutations]);
  }
  authorizeAndTransact(
    scope: Scope,
    input: AuthorizationInput,
    mutations: Mutation[],
    event: { type: string; aggregateId: string; data?: unknown },
  ): Promise<Document<unknown>[]> {
    return this.call("authorizeAndTransact", [scope, input, mutations, event]);
  }
  createMandate(mandate: Mandate): Promise<Mandate> {
    return this.call("createMandate", [mandate]);
  }
  revokeMandate(scope: Scope, id: string, version: number): Promise<void> {
    return this.call("revokeMandate", [scope, id, version]);
  }
  approve(scope: Scope, binding: ApprovalBinding, decision: "approved" | "denied" = "approved"): Promise<Approval> {
    return this.call("approve", [scope, binding, decision]);
  }
  assertAuthorized(scope: Scope, input: AuthorizationInput): Promise<void> {
    return this.call("assertAuthorized", [scope, input]);
  }
  reserveAndTransact(
    scope: Scope,
    input: ReserveInput,
    mutations: Mutation[],
    event: { type: string; aggregateId: string; data?: unknown },
  ): Promise<Document<unknown>[]> {
    return this.call("reserveAndTransact", [scope, input, mutations, event]);
  }
  settleAndTransact(
    scope: Scope,
    input: { reservationId: string; actualMicros?: string },
    mutations: Mutation[],
    event: { type: string; aggregateId: string; data?: unknown },
  ): Promise<Document<unknown>[]> {
    return this.call("settleAndTransact", [scope, input, mutations, event]);
  }
  reserve(scope: Scope, input: ReserveInput): Promise<Reservation> {
    return this.call("reserve", [scope, input]);
  }
  settle(scope: Scope, id: string, actualMicros: string): Promise<Reservation> {
    return this.call("settle", [scope, id, actualMicros]);
  }
  markUnreconciled(scope: Scope, id: string): Promise<Reservation> {
    return this.call("markUnreconciled", [scope, id]);
  }
  releaseReservation(scope: Scope, id: string): Promise<Reservation> {
    return this.call("releaseReservation", [scope, id]);
  }
  budget(companyId: string): Promise<Budget> {
    return this.call("budget", [companyId]);
  }
  events(scope: Scope, after = 0, limit = 100): Promise<EventRecord[]> {
    return this.call("events", [scope, after, limit]);
  }
  verifyAudit(companyId: string): Promise<boolean> {
    return this.call("verifyAudit", [companyId]);
  }
  pendingOutbox(companyId: string): Promise<{ id: string; eventSequence: number; data: EventRecord }[]> {
    return this.call("pendingOutbox", [companyId]);
  }
  acknowledgeOutbox(companyId: string, id: string): Promise<void> {
    return this.call("acknowledgeOutbox", [companyId, id]);
  }
  backup(path: string): Promise<void> {
    return this.call("backup", [path]);
  }
}
