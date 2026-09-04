/**
 * A base for one-off runtimes in tests.
 *
 * Hand-writing the whole `AgentRuntime` interface in a test buys nothing and
 * costs something real: the stub drifts the moment the contract grows a
 * method or a field, and then the test passes against a runtime that could
 * not exist in the running system. So the parts a test does not care about
 * are delegated to `MockRuntime`, which is the maintained implementation, and
 * a subclass overrides only `startRun` — the part actually under test.
 *
 * `id` and `type` are plain strings rather than literals so a stub can name
 * itself; MockRuntime's own are literal `"mock"` and cannot be overridden.
 */

import { MockRuntime } from "../mock-runtime.ts";
import { newId } from "../../domain/ids.ts";
import type { AgentRuntime, RunContext, RunEvent, RunEventType, RunInput } from "../run-events.ts";

export abstract class StubRuntime implements AgentRuntime {
  private readonly base = new MockRuntime();

  constructor(
    readonly id: string,
    readonly type: string = id,
  ) {}

  capabilities() {
    return this.base.capabilities();
  }
  healthCheck() {
    return this.base.healthCheck();
  }
  authStatus() {
    return this.base.authStatus();
  }
  cancelRun(runId: string) {
    return this.base.cancelRun(runId);
  }

  abstract startRun(input: RunInput, context: RunContext): AsyncIterable<RunEvent>;
}

/** Builds a well-formed event for a stub to yield, so tests do not cast. */
export function stubEvent(
  context: RunContext,
  type: RunEventType,
  payload: Record<string, unknown> = {},
  seq = 0,
): RunEvent {
  return {
    eventId: newId("evt"),
    companyId: context.companyId,
    projectId: context.projectId,
    taskId: context.taskId,
    runId: context.runId,
    agentId: context.agentId,
    seq,
    type,
    timestamp: Date.now(),
    correlationId: context.correlationId,
    payload,
    redaction: { redacted: false, rules: [] },
  };
}
