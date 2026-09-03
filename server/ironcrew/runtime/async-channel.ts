/**
 * IronCrew — async event channel.
 *
 * Bridges an event-driven producer (child process stdout/stderr/exit
 * listeners) into the pull-based `AsyncIterable<RunEvent>` shape
 * `AgentRuntime.startRun()` promises.
 *
 * Ordering is preserved: a value pushed before anyone is pulling is queued;
 * a pull that arrives before a value exists parks until one is pushed. Once
 * closed, queued values still drain before the iterator ends, and a close
 * error (if any) surfaces only after the queue is empty — a producer that
 * fails after emitting useful events does not erase them.
 */

export class AsyncEventChannel<T> implements AsyncIterable<T> {
  private readonly queue: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;
  private closeError: unknown;

  /** Enqueue a value. A no-op after close(), so a late event is dropped rather than throwing. */
  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.queue.push(value);
  }

  /** Signal no more values will be pushed. Idempotent. */
  close(error?: unknown): void {
    if (this.closed) return;
    this.closed = true;
    this.closeError = error;
    // Invariant: a waiter is only ever parked when the queue is empty (push()
    // always satisfies a waiting puller before it queues), so waking every
    // parked waiter here can never skip past undelivered queued values.
    while (this.waiters.length) {
      this.waiters.shift()!({ value: undefined as never, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T, void, unknown> {
    while (true) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!;
        continue;
      }
      if (this.closed) {
        if (this.closeError !== undefined) throw this.closeError;
        return;
      }
      const result = await new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve));
      if (result.done) {
        if (this.closeError !== undefined) throw this.closeError;
        return;
      }
      yield result.value;
    }
  }
}
