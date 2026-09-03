/**
 * Per-task serialization lock.
 * Ensures only one onPhaseComplete runs at a time per taskId,
 * preventing race conditions when fan-out phases complete simultaneously.
 */
export function createTaskPhaseLock() {
  const locks = new Map<string, Promise<void>>();

  return {
    async acquire<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
      const prev = locks.get(taskId) ?? Promise.resolve();
      let resolve: () => void;
      const next = new Promise<void>((r) => {
        resolve = r;
      });
      locks.set(taskId, next);

      await prev;
      try {
        return await fn();
      } finally {
        // Resolve MUST happen before the identity check — the next waiter
        // in the chain cannot proceed until this promise resolves, and if
        // we deleted the lock first another concurrent acquire() could
        // miss the chain entirely.
        resolve!();
        // Only clean up the map entry if no subsequent acquire() has
        // replaced our promise. If another acquire() has already inserted
        // a newer promise, deleting would break the chain for that waiter.
        if (locks.get(taskId) === next) {
          locks.delete(taskId);
        }
      }
    },

    get size() {
      return locks.size;
    },
  };
}
