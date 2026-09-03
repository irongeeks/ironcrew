import { logger } from "../../../observability/logger.ts";

const log = logger.child({ module: "token-accumulator" });

interface TokenUsageEvent {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  model?: string;
  subtask_id?: string;
}

interface TokenBudget {
  maxInput: number;
  maxOutput: number;
}

interface TokenAccumulatorDeps {
  db: {
    prepare: (sql: string) => {
      run: (...args: unknown[]) => unknown;
    };
  };
  appendTaskLog: (taskId: string, kind: string, message: string) => void;
  broadcast: (event: string, payload: unknown) => void;
  nowMs: () => number;
}

export type BudgetCheckResult = "ok" | "warning" | "exceeded";

export class TokenAccumulator {
  totalInput = 0;
  totalOutput = 0;
  private totalCacheRead = 0;
  private totalCacheWrite = 0;
  private warningEmitted = false;

  constructor(
    private readonly taskId: string,
    private readonly agentId: string | null,
    private readonly provider: string,
    private readonly deps: TokenAccumulatorDeps,
    private readonly budget: TokenBudget | null,
  ) {}

  record(event: TokenUsageEvent): BudgetCheckResult {
    this.totalInput += event.input_tokens;
    this.totalOutput += event.output_tokens;
    this.totalCacheRead += event.cache_read_tokens ?? 0;
    this.totalCacheWrite += event.cache_write_tokens ?? 0;

    // Persist to DB
    try {
      this.deps.db
        .prepare(
          `INSERT INTO token_usage (task_id, subtask_id, agent_id, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, recorded_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          this.taskId,
          event.subtask_id ?? null,
          this.agentId,
          this.provider,
          event.model ?? null,
          event.input_tokens,
          event.output_tokens,
          event.cache_read_tokens ?? 0,
          event.cache_write_tokens ?? 0,
          this.deps.nowMs(),
        );
    } catch (err) {
      log.error({ err, taskId: this.taskId }, "failed to persist token usage");
    }

    return this.checkBudget();
  }

  getSummary() {
    return {
      input_tokens: this.totalInput,
      output_tokens: this.totalOutput,
      cache_read_tokens: this.totalCacheRead,
      cache_write_tokens: this.totalCacheWrite,
    };
  }

  private checkBudget(): BudgetCheckResult {
    if (!this.budget) return "ok";

    const inputRatio = this.budget.maxInput === Infinity ? 0 : this.totalInput / this.budget.maxInput;
    const outputRatio = this.budget.maxOutput === Infinity ? 0 : this.totalOutput / this.budget.maxOutput;
    const maxRatio = Math.max(inputRatio, outputRatio);

    if (maxRatio >= 1) {
      this.deps.appendTaskLog(
        this.taskId,
        "token_budget_exceeded",
        `Token budget exceeded: ${this.totalInput} input / ${this.totalOutput} output tokens (limit: ${this.budget.maxInput} / ${this.budget.maxOutput})`,
      );
      return "exceeded";
    }

    if (maxRatio >= 0.8 && !this.warningEmitted) {
      this.warningEmitted = true;
      const msg = `Token usage at ${Math.round(maxRatio * 100)}%: ${this.totalInput} input / ${this.totalOutput} output tokens (limit: ${this.budget.maxInput} / ${this.budget.maxOutput})`;
      this.deps.appendTaskLog(this.taskId, "token_budget_warning", msg);
      this.deps.broadcast("token_budget_warning", { task_id: this.taskId, message: msg, ratio: maxRatio });
      return "warning";
    }

    return "ok";
  }
}
