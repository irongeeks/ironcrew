import { z } from "zod";
import { Repository } from "../../persistence/src/index.ts";
import type { Scope, Json } from "../../contracts/src/index.ts";
import { DomainError, sha256 } from "../src/index.ts";
import { shaUuid } from "../../runtime/src/engine.ts";
import { ManagedActions, type ActionRequest } from "./actions.ts";
type Observation = {
  at: string;
  kind: "alarm" | "diagnosis" | "repair" | "functional_check" | "observation" | "recurrence";
  targetId: string;
  data: Json;
};
export type Incident = {
  id: string;
  orderId: string;
  targetId: string;
  state: "investigating" | "repairing" | "observing" | "resolved" | "blocked";
  cause: { status: "unknown" | "suspected" | "confirmed"; explanation: string };
  timeline: Observation[];
  observationEndsAt?: string;
  lastCheckAt?: string;
  preventionOrderId?: string;
};
export class IncidentWorkflow {
  repo: Repository;
  now: () => Date;
  constructor(repo: Repository, now: () => Date = () => new Date()) {
    this.repo = repo;
    this.now = now;
  }
  async ingest(
    scope: Scope,
    input: {
      provider: string;
      accountId: string;
      eventId: string;
      targetId: string;
      summary: string;
      budgetLimitUsdMicros: string;
    },
  ) {
    z.object({
      provider: z.string().min(1),
      accountId: z.string().min(1),
      eventId: z.string().min(1),
      targetId: z.uuid(),
      summary: z.string().trim().min(1),
    }).parse(input);
    const id = shaUuid(JSON.stringify([input.provider, input.accountId, input.eventId])),
      payloadHash = sha256(input);
    const lookup = () => this.repo.getDocument<{ orderId: string; payloadHash: string }>(scope, "alarm-inbox", id);
    const prior = await lookup();
    if (prior) {
      if (prior.data.payloadHash !== payloadHash) throw new DomainError("inbox_event_conflict");
      return this.required(scope, prior.data.orderId);
    }
    const setup = await this.repo.snapshot(scope.companyId),
      lead = setup.employees.find((e) => e.seedKey === "operations")!;
    const incident: Incident = {
      id,
      orderId: id,
      targetId: input.targetId,
      state: "investigating",
      cause: { status: "unknown", explanation: "Noch kein Ursachenbeleg" },
      timeline: [
        { at: this.now().toISOString(), kind: "alarm", targetId: input.targetId, data: { summary: input.summary } },
      ],
    };
    try {
      await this.repo.createOrderAndTransact(
        scope,
        {
          id,
          goal: input.summary,
          kind: "incident",
          leadEmployeeId: lead.id,
          budgetLimitUsdMicros: input.budgetLimitUsdMicros,
          acceptanceCriteria: [
            "Independent functional check",
            "Observation completed",
            "Customer communication explicitly approved",
          ],
        },
        [
          { kind: "alarm-inbox", id, data: { orderId: id, payloadHash }, immutable: true },
          { kind: "incident", id, data: incident },
        ],
        { type: "incident.received", aggregateId: id },
      );
    } catch (error) {
      const concurrent = await lookup();
      if (!concurrent || concurrent.data.payloadHash !== payloadHash) throw error;
    }
    return this.required(scope, id);
  }
  async diagnose(
    scope: Scope,
    id: string,
    input: { evidence: string; causeStatus: Incident["cause"]["status"]; explanation: string },
  ) {
    if (!input.evidence.trim()) throw new DomainError("diagnosis_evidence_required");
    const incident = await this.required(scope, id);
    return this.repo.putDocument(
      scope,
      "incident",
      id,
      {
        ...incident.data,
        cause: { status: input.causeStatus, explanation: input.explanation },
        timeline: [
          ...incident.data.timeline,
          { at: this.now().toISOString(), kind: "diagnosis", targetId: incident.data.targetId, data: input },
        ],
      },
      { expectedRevision: incident.revision },
    );
  }
  async repair(
    scope: Scope,
    id: string,
    actions: ManagedActions,
    request: Omit<ActionRequest, "scope" | "orderId" | "targetId">,
    execute: () => Promise<unknown>,
  ) {
    const incident = await this.required(scope, id);
    const result = await actions.perform({ ...request, scope, orderId: id, targetId: incident.data.targetId }, execute);
    const current = await this.required(scope, id);
    await this.repo.putDocument(
      scope,
      "incident",
      id,
      {
        ...current.data,
        state:
          result.state === "succeeded" ? "repairing" : result.state === "approval" ? current.data.state : "blocked",
        timeline: [
          ...current.data.timeline,
          {
            at: this.now().toISOString(),
            kind: "repair",
            targetId: current.data.targetId,
            data: { actionId: result.id, status: result.state },
          },
        ],
      },
      { expectedRevision: current.revision },
    );
    return result;
  }
  async check(
    scope: Scope,
    id: string,
    observationSeconds: number,
    probe: () => Promise<{ ok: boolean; evidence: string }>,
  ) {
    if (!Number.isSafeInteger(observationSeconds) || observationSeconds < 1 || observationSeconds > 86400)
      throw new DomainError("invalid_observation_period");
    const incident = await this.required(scope, id);
    let result: { ok: boolean; evidence: string };
    try {
      result = await probe();
    } catch {
      result = { ok: false, evidence: "Funktionsprüfung nicht verfügbar" };
    }
    if (!result.evidence.trim()) throw new DomainError("check_evidence_required");
    const now = this.now();
    const wasObserving = incident.data.state === "observing";
    const ended = wasObserving && Date.parse(incident.data.observationEndsAt!) <= now.getTime();
    const state: Incident["state"] = !result.ok ? "investigating" : ended ? "resolved" : "observing";
    return this.repo.putDocument(
      scope,
      "incident",
      id,
      {
        ...incident.data,
        state,
        lastCheckAt: now.toISOString(),
        observationEndsAt:
          wasObserving && result.ok
            ? incident.data.observationEndsAt
            : new Date(now.getTime() + observationSeconds * 1000).toISOString(),
        timeline: [
          ...incident.data.timeline,
          {
            at: now.toISOString(),
            kind: !result.ok && wasObserving ? "recurrence" : wasObserving ? "observation" : "functional_check",
            targetId: incident.data.targetId,
            data: result,
          },
        ],
      },
      { expectedRevision: incident.revision },
    );
  }
  async prevention(scope: Scope, id: string, goal: string, budgetLimitUsdMicros: string) {
    const incident = await this.required(scope, id);
    if (incident.data.preventionOrderId) return this.repo.getOrder(scope, incident.data.preventionOrderId);
    const parent = await this.repo.getOrder(scope, id),
      childId = shaUuid("prevention:" + id);
    try {
      const result = await this.repo.createOrderAndTransact(
        scope,
        {
          id: childId,
          kind: "incident",
          goal,
          leadEmployeeId: parent.leadEmployeeId,
          budgetLimitUsdMicros,
          acceptanceCriteria: ["Prevention independently verified"],
        },
        [
          {
            kind: "incident",
            id,
            data: { ...incident.data, preventionOrderId: childId },
            expectedRevision: incident.revision,
          },
        ],
        { type: "incident.prevention_created", aggregateId: id },
      );
      return result.order;
    } catch (error) {
      const current = await this.required(scope, id);
      if (current.data.preventionOrderId) return this.repo.getOrder(scope, current.data.preventionOrderId);
      throw error;
    }
  }
  async customerMessage(
    scope: Scope,
    id: string,
    actions: ManagedActions,
    request: Omit<ActionRequest, "scope" | "orderId" | "effect" | "requireApproval">,
    send: () => Promise<unknown>,
  ) {
    const incident = await this.required(scope, id);
    const args = z.object({ to: z.email(), content: z.string().min(1), incidentState: z.string() }).parse(request.args);
    if (args.incidentState !== incident.data.state) throw new DomainError("message_outdated");
    return actions.perform({ ...request, scope, orderId: id, effect: "external_send", requireApproval: true }, send);
  }
  private async required(scope: Scope, id: string) {
    const doc = await this.repo.getDocument<Incident>(scope, "incident", id);
    if (!doc) throw new DomainError("incident_not_found");
    return doc;
  }
}
