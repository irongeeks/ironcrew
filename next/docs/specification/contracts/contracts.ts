/** Specification seed, not a complete runtime SDK. Validate all wire data with Zod.
 * Monetary integer values use decimal strings on JSON boundaries to avoid precision loss.
 */
export type Id = string;
export type IsoDate = string;
export type Micros = string;
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type OrderStatus = 'inbox' | 'planning' | 'ready' | 'running' | 'reviewing'
  | 'completed' | 'paused' | 'blocked' | 'cancelled' | 'failed';
export type WaitReason = 'approval' | 'budget' | 'external' | 'worker' | 'tool_error'
  | 'unknown_effect' | 'user_input';
export type EffectClass = 'read' | 'workspace_write' | 'external_draft'
  | 'external_change' | 'external_send' | 'publish';
export type ActionStatus = 'proposed' | 'authorized' | 'dispatched' | 'running'
  | 'succeeded' | 'failed' | 'effect_unknown' | 'denied' | 'expired';
export interface Scope {
  companyId: Id; areaId: Id; customerId?: Id; projectId?: Id;
}
export interface Order {
  id: Id; scope: Scope; kind: 'website' | 'incident' | 'finance' | 'research';
  goal: string; leadEmployeeId: Id; status: OrderStatus; waitReason?: WaitReason;
  revision: number; planVersion: number; acceptanceCriteria: string[];
  budgetLimitUsdMicros: Micros; createdAt: IsoDate; updatedAt: IsoDate;
}
export interface SecretRef {
  provider: 'proton-pass'; shareId: string; itemId: string; field: string;
}
export interface Mandate {
  id: Id; version: number; scope: Scope; allowedToolIds: string[];
  targetIds: Id[]; parameterConstraints: Json; expiresAt: IsoDate;
  revokedAt?: IsoDate; maxAttempts: number; maxDurationSeconds: number;
  maxCostUsdMicros: Micros;
}
export interface ApprovalBinding {
  companyId: Id; orderId: Id; mandateId: Id; mandateVersion: number;
  actionId: Id; targetId: Id; argumentsSha256: string; artifactVersionId?: Id;
  expiresAt: IsoDate;
}
export interface ToolDefinition {
  id: string; version: number; effect: EffectClass;
  retryPolicy: 'safe' | 'idempotency_key' | 'reconcile_first' | 'never_automatic';
  inputSchemaId: string; outputSchemaId: string; capability: string;
  reconcileToolId?: string;
}
export interface ToolAction {
  id: Id; runId: Id; orderId: Id; scope: Scope; toolId: string; toolVersion: number;
  args: Json; argumentsSha256: string; status: ActionStatus;
  mandateId: Id; mandateVersion: number; approvalId?: Id;
  externalId?: string; resultSha256?: string; evidenceRefs: Id[];
}
export interface ModelTurn {
  id: Id; runId: Id; sequence: number; modelId: string; profileVersion: number;
  messagesArtifactId: Id; requestSha256: string; reservationId: Id;
  state: 'prepared' | 'sent' | 'streaming' | 'complete' | 'interrupted' | 'failed';
  providerGenerationId?: string; inputTokens?: number; outputTokens?: number;
  reportedCostUsdMicros?: Micros; usageState: 'pending' | 'reconciled' | 'unreconciled';
}
export interface Reservation {
  id: Id; periodId: Id; orderId: Id; modelTurnId?: Id; actionId?: Id;
  reservedUsdMicros: Micros; settledUsdMicros?: Micros;
  state: 'held' | 'settled' | 'released' | 'unreconciled';
}
export interface ArtifactVersion {
  id: Id; artifactId: Id; scope: Scope; orderId: Id; sha256: string;
  mediaType: string; bytes: number; predecessorId?: Id;
  canonicalStore: 'internal' | 'git' | 'nextcloud' | 'gdrive';
  delivery: 'staged' | 'pending' | 'delivered' | 'conflict' | 'failed';
  externalId?: string; externalRevision?: string;
}
export interface Envelope<T> {
  protocolVersion: 1; messageId: Id; workerId: Id; generation: number;
  sequence: number; sentAt: IsoDate; payload: T;
}
export type WorkerMessage = Envelope<
  | { type: 'hello'; capabilities: string[]; appVersion: string; maxConcurrent: number }
  | { type: 'heartbeat'; activeActionIds: Id[] }
  | { type: 'started'; actionId: Id; leaseId: Id }
  | { type: 'result'; actionId: Id; leaseId: Id; resultSha256: string;
      status: 'succeeded' | 'failed' | 'effect_unknown'; data: Json; evidenceRefs: Id[] }
>;
export type ControlMessage = Envelope<
  | { type: 'dispatch'; action: ToolAction; leaseId: Id; expiresAt: IsoDate }
  | { type: 'ack'; acknowledgedMessageId: Id; actionId?: Id }
  | { type: 'cancel'; actionId: Id; reason: string }
  | { type: 'reconcile'; actionId: Id }
>;
export interface ApiError {
  code: string; messageKey: string; requestId: Id; retryable: boolean;
  actionId?: Id; details?: Json;
}
export interface EventRecord {
  id: Id; sequence: number; scope: Scope; aggregateId: Id; aggregateRevision: number;
  type: string; occurredAt: IsoDate; data: Json;
}
