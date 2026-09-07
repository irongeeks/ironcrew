import { randomBytes, randomUUID } from "node:crypto";
import { CronExpressionParser } from "cron-parser";
import { z } from "zod";
import { Repository } from "../../persistence/src/index.ts";
import type { Scope, Order, Json, Mandate } from "../../contracts/src/index.ts";
import { microsSchema, orderKindSchema } from "../../contracts/src/index.ts";
import { DomainError, sha256 } from "../src/index.ts";
import { shaUuid } from "../../runtime/src/engine.ts";
import { digest } from "../../tools/workspace.ts";
export type Schedule = {
  id: string;
  scope: Scope;
  cron: string;
  timezone: string;
  version: number;
  nextDueAt: string;
  enabled: boolean;
  goal: string;
  kind: Order["kind"];
  leadEmployeeId: string;
  budgetLimitUsdMicros: string;
  mandateId: string;
  mandateVersion: number;
  maxActiveOrders: number;
  activeOrderIds: string[];
  lastLocalSlot?: string;
  lastSuccessfulAt?: string;
};
type ScheduleInput = Omit<Schedule, "id" | "scope" | "nextDueAt" | "version" | "activeOrderIds" | "mandateVersion"> & {
  mandateVersion?: number;
};
export const scheduleInputSchema = z
  .object({
    cron: z.string().min(1),
    timezone: z.string().min(1),
    enabled: z.boolean(),
    goal: z.string().trim().min(1),
    kind: orderKindSchema,
    leadEmployeeId: z.uuid(),
    budgetLimitUsdMicros: microsSchema,
    mandateId: z.uuid(),
    mandateVersion: z.number().int().positive().optional(),
    maxActiveOrders: z.number().int().min(1).max(3),
    lastLocalSlot: z.string().optional(),
    lastSuccessfulAt: z.iso.datetime().optional(),
  })
  .strict();
export class Scheduler {
  repo: Repository;
  constructor(repo: Repository) {
    this.repo = repo;
  }
  next(cron: string, timezone: string, after: Date) {
    if (!Number.isFinite(after.getTime())) throw new DomainError("invalid_schedule_date");
    new Intl.DateTimeFormat("en", { timeZone: timezone });
    return CronExpressionParser.parse(cron, { tz: timezone, currentDate: after }).next().toISOString()!;
  }
  async create(scope: Scope, input: ScheduleInput, now = new Date()) {
    const valid = scheduleInputSchema.parse(input);
    const setup = await this.repo.snapshot(scope.companyId);
    if (!setup.employees.some((e) => e.id === valid.leadEmployeeId)) throw new DomainError("invalid_lead");
    const versions = (await this.repo.listDocuments<Mandate>(scope, "mandate"))
      .filter(
        (m) => m.data.id === valid.mandateId && (!valid.mandateVersion || m.data.version === valid.mandateVersion),
      )
      .sort((a, b) => b.data.version - a.data.version);
    const mandate = versions[0]?.data;
    if (
      !mandate ||
      mandate.revokedAt ||
      Date.parse(mandate.expiresAt) <= now.getTime() ||
      (await this.repo.getDocument(scope, "mandate_revocation", `${mandate.id}:${mandate.version}`))
    )
      throw new DomainError("mandate_unavailable");
    if (BigInt(valid.budgetLimitUsdMicros) > BigInt(mandate.maxCostUsdMicros))
      throw new DomainError("mandate_budget_exceeded");
    const schedule: Schedule = {
      ...valid,
      id: randomUUID(),
      scope,
      version: 1,
      mandateVersion: mandate.version,
      nextDueAt: this.next(valid.cron, valid.timezone, now),
      activeOrderIds: [],
    };
    await this.repo.putDocument(scope, "schedule", schedule.id, schedule);
    return schedule;
  }
  async tick(scope: Scope, now = new Date()) {
    const setup = await this.repo.snapshot(scope.companyId);
    const recovery = await this.repo.getDocument<{ schedulesPaused: boolean; dispatchPaused: boolean }>(
      { companyId: scope.companyId, areaId: setup.areas[0]!.id },
      "recovery-state",
      scope.companyId,
    );
    if (recovery?.data.schedulesPaused || recovery?.data.dispatchPaused) return [];
    const created: Order[] = [];
    for (const doc of await this.repo.listDocuments<Schedule>(scope, "schedule")) {
      const schedule = doc.data;
      if (!schedule.enabled || Date.parse(schedule.nextDueAt) > now.getTime()) continue;
      const active: Order[] = [];
      for (const id of schedule.activeOrderIds) {
        const order = await this.repo.getOrder(scope, id);
        if (!["completed", "cancelled", "failed"].includes(order.status)) active.push(order);
      }
      if (active.length > 0) continue;
      const slot = new Intl.DateTimeFormat("sv-SE", {
        timeZone: schedule.timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).format(new Date(schedule.nextDueAt));
      const nextDueAt = this.next(schedule.cron, schedule.timezone, now);
      if (slot === schedule.lastLocalSlot) {
        try {
          await this.repo.putDocument(
            scope,
            "schedule",
            schedule.id,
            { ...schedule, nextDueAt },
            { expectedRevision: doc.revision },
          );
        } catch (error) {
          if (!(error instanceof DomainError && error.code === "revision_conflict")) throw error;
        }
        continue;
      }
      const orderId = shaUuid(JSON.stringify([schedule.id, schedule.version, schedule.nextDueAt]));
      try {
        const result = await this.repo.createOrderAndTransact(
          scope,
          {
            id: orderId,
            kind: schedule.kind,
            goal: schedule.goal,
            leadEmployeeId: schedule.leadEmployeeId,
            budgetLimitUsdMicros: schedule.budgetLimitUsdMicros,
            acceptanceCriteria: ["Scheduled task reviewed"],
          },
          [
            {
              kind: "schedule",
              id: schedule.id,
              data: {
                ...schedule,
                nextDueAt,
                lastLocalSlot: slot,
                lastSuccessfulAt: now.toISOString(),
                activeOrderIds: [orderId],
              },
              expectedRevision: doc.revision,
            },
            {
              kind: "schedule-fire",
              id: orderId,
              data: {
                id: orderId,
                scheduleId: schedule.id,
                orderId,
                dueAt: schedule.nextDueAt,
                coalescedUntil: now.toISOString(),
              },
              immutable: true,
            },
          ],
          { type: "schedule.fired", aggregateId: orderId },
          {
            mandateId: schedule.mandateId,
            mandateVersion: schedule.mandateVersion,
            now: now.toISOString(),
            maxActiveOrders: schedule.maxActiveOrders,
          },
        );
        created.push(result.order);
      } catch (error) {
        if (
          error instanceof DomainError &&
          [
            "mandate_unavailable",
            "mandate_budget_exceeded",
            "company_budget_exceeded",
            "schedule_goal_limit",
            "recovery_dispatch_paused",
          ].includes(error.code)
        )
          continue;
        const current = await this.repo.getDocument(scope, "schedule", schedule.id);
        if (current && current.revision !== doc.revision) continue;
        throw error;
      }
    }
    return created;
  }
}
export class Channels {
  repo: Repository;
  constructor(repo: Repository) {
    this.repo = repo;
  }
  async challenge(scope: Scope, provider: "discord" | "telegram") {
    z.enum(["discord", "telegram"]).parse(provider);
    const token = randomBytes(24).toString("base64url"),
      id = shaUuid(token);
    await this.repo.putDocument(scope, "identity-challenge", id, {
      provider,
      hash: digest(token),
      expiresAt: Date.now() + 600_000,
      used: false,
    });
    return { challenge: token, expiresAt: new Date(Date.now() + 600_000).toISOString() };
  }
  async bind(
    scope: Scope,
    provider: "discord" | "telegram",
    token: string,
    accountId: string,
    userId: string,
    authenticatedProviderEvent: boolean,
  ) {
    if (!authenticatedProviderEvent) throw new DomainError("provider_event_unverified");
    z.object({
      provider: z.enum(["discord", "telegram"]),
      accountId: z.string().min(1),
      userId: z.string().min(1),
    }).parse({ provider, accountId, userId });
    const id = shaUuid(token);
    const challenge = await this.repo.getDocument<{ provider: string; hash: string; expiresAt: number; used: boolean }>(
      scope,
      "identity-challenge",
      id,
    );
    if (
      !challenge ||
      challenge.data.provider !== provider ||
      challenge.data.used ||
      challenge.data.expiresAt <= Date.now() ||
      challenge.data.hash !== digest(token)
    )
      throw new DomainError("identity_challenge_invalid");
    const bindingId = shaUuid(JSON.stringify([provider, accountId]));
    const existing = await this.repo.getDocument(scope, "channel-identity", bindingId);
    await this.repo.transact(
      scope,
      [
        {
          kind: "identity-challenge",
          id,
          data: { ...challenge.data, used: true },
          expectedRevision: challenge.revision,
        },
        {
          kind: "channel-identity",
          id: bindingId,
          data: { provider, accountId, userId, role: "ceo", verifiedAt: new Date().toISOString() },
          expectedRevision: existing?.revision ?? 0,
        },
      ],
      { type: "channel.bound", aggregateId: bindingId },
    );
    return { bound: true };
  }
  async receive(
    scope: Scope,
    input: {
      provider: "discord" | "telegram" | "email";
      accountId: string;
      eventId: string;
      senderId: string;
      content: string;
      authenticated: boolean;
      kind: Order["kind"];
      budgetLimitUsdMicros: string;
    },
  ) {
    if (!input.authenticated) throw new DomainError("provider_event_unverified");
    z.object({
      provider: z.enum(["discord", "telegram", "email"]),
      accountId: z.string().min(1),
      eventId: z.string().min(1),
      senderId: z.string().min(1),
      content: z.string().trim().min(1).max(20000),
    }).parse(input);
    const id = shaUuid(JSON.stringify([input.provider, input.accountId, input.eventId])),
      payloadHash = sha256(input);
    const lookup = () => this.repo.getDocument<{ orderId: string; payloadHash: string }>(scope, "channel-inbox", id);
    const prior = await lookup();
    if (prior) {
      if (prior.data.payloadHash !== payloadHash) throw new DomainError("inbox_event_conflict");
      return { duplicate: true, orderId: prior.data.orderId };
    }
    const identity = await this.repo.getDocument<{ userId: string }>(
      scope,
      "channel-identity",
      shaUuid(JSON.stringify([input.provider, input.accountId])),
    );
    const ceo = input.provider !== "email" && identity?.data.userId === input.senderId;
    // Incoming text never executes an approval, including text from a verified CEO channel.
    try {
      await this.repo.createOrderAndTransact(
        scope,
        { id, kind: input.kind, goal: input.content, budgetLimitUsdMicros: input.budgetLimitUsdMicros },
        [
          {
            kind: "channel-inbox",
            id,
            data: {
              id,
              provider: input.provider,
              accountId: input.accountId,
              eventId: input.eventId,
              senderId: input.senderId,
              payloadHash,
              orderId: id,
              role: ceo ? "ceo" : "external",
              approvalAllowed: false,
              createdAt: new Date().toISOString(),
            },
            immutable: true,
          },
        ],
        { type: "channel.received", aggregateId: id },
      );
    } catch (error) {
      const concurrent = await lookup();
      if (concurrent && concurrent.data.payloadHash === payloadHash)
        return { duplicate: true, orderId: concurrent.data.orderId };
      throw error;
    }
    return { duplicate: false, orderId: id, ceo };
  }
  async draft(scope: Scope, orderId: string, input: { provider: string; recipient: string; content: string }) {
    await this.repo.getOrder(scope, orderId);
    z.object({
      provider: z.enum(["discord", "telegram", "email"]),
      recipient: z.string().trim().min(1),
      content: z.string().trim().min(1).max(20000),
    }).parse(input);
    const id = randomUUID();
    return this.repo.putDocument(scope, "channel-outbox", id, {
      ...input,
      id,
      orderId,
      state: "prepared",
      evidence: [] as Json[],
    });
  }
}
