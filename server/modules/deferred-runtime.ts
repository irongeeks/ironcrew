const DEFERRED_RUNTIME_FN_TAG = Symbol.for("ironcrew.deferredRuntimeFnName");

type RuntimeRecord = Record<string, any>;

function createDeferredRuntimeFunction(runtime: RuntimeRecord, name: string): (...args: any[]) => any {
  const deferred = (...args: any[]) => {
    const current = runtime[name];
    if (typeof current !== "function" || current === deferred) {
      throw new Error(`${name}_not_initialized`);
    }
    return current(...args);
  };

  Object.defineProperty(deferred, DEFERRED_RUNTIME_FN_TAG, {
    value: name,
    enumerable: false,
    configurable: false,
    writable: false,
  });

  return deferred;
}

function isDeferredRuntimeFunction(value: unknown): value is (...args: any[]) => any {
  return typeof value === "function" && Object.prototype.hasOwnProperty.call(value, DEFERRED_RUNTIME_FN_TAG);
}

function getDeferredRuntimeFunctionName(value: unknown): string | null {
  if (!isDeferredRuntimeFunction(value)) return null;
  const name = (value as unknown as Record<PropertyKey, unknown>)[DEFERRED_RUNTIME_FN_TAG];
  return typeof name === "string" ? name : null;
}

export function createDeferredRuntimeProxy<T extends RuntimeRecord>(runtime: T): T {
  return new Proxy(runtime, {
    get(target, prop, receiver) {
      if (typeof prop !== "string") return Reflect.get(target, prop, receiver);

      if (!Reflect.has(target, prop)) {
        const deferred = createDeferredRuntimeFunction(target, prop);
        Reflect.set(target, prop, deferred, receiver);
        return deferred;
      }

      return Reflect.get(target, prop, receiver);
    },
  }) as T;
}

function collectUnresolvedDeferredRuntimeFunctions(runtime: RuntimeRecord): string[] {
  const unresolved = new Set<string>();

  for (const value of Object.values(runtime)) {
    const name = getDeferredRuntimeFunctionName(value);
    if (!name) continue;
    unresolved.add(name);
  }

  return [...unresolved].sort();
}

function normalizeIgnoredNames(ignoreNames?: Iterable<string>): Set<string> {
  if (!ignoreNames) return new Set<string>();
  return new Set(ignoreNames);
}

export function assertNoUnresolvedDeferredRuntimeFunctions(
  runtime: RuntimeRecord,
  label: string = "runtime helper wiring",
  options?: {
    ignoreNames?: Iterable<string>;
  },
): void {
  const ignored = normalizeIgnoredNames(options?.ignoreNames);
  const unresolved = collectUnresolvedDeferredRuntimeFunctions(runtime).filter((name) => !ignored.has(name));
  if (unresolved.length > 0) {
    throw new Error(`[IronCrew] ${label} incomplete: ${unresolved.join(", ")}`);
  }
}

export function assertRuntimeFunctionsResolved(
  runtime: RuntimeRecord,
  functionNames: Iterable<string>,
  label: string = "runtime helper wiring",
): void {
  const uniqueNames = [...new Set(functionNames)];
  const missing: string[] = [];
  const unresolved: string[] = [];

  for (const name of uniqueNames) {
    const value = runtime[name];
    if (typeof value !== "function") {
      missing.push(name);
      continue;
    }
    if (isDeferredRuntimeFunction(value)) {
      unresolved.push(name);
    }
  }

  if (missing.length > 0 || unresolved.length > 0) {
    const parts: string[] = [];
    if (missing.length > 0) parts.push(`missing: ${missing.sort().join(", ")}`);
    if (unresolved.length > 0) parts.push(`unresolved: ${unresolved.sort().join(", ")}`);
    throw new Error(`[IronCrew] ${label} ${parts.join(" | ")}`);
  }
}
