import { describe, expect, it } from "vitest";

import { registerDesignParserRoutes } from "./core/design-parser.ts";
import { registerDocsRoutes } from "./docs/routes.ts";
import { registerOperationsRoutes } from "./ops/operations.ts";
import { registerServerManagementRoutes } from "./ops/servers.ts";

type Next = () => void;
type Handler = (req: any, res: any, next?: Next) => unknown;

type FakeRes = {
  statusCode: number;
  payload: unknown;
  status: (code: number) => FakeRes;
  json: (body: unknown) => FakeRes;
};

type StubStmt = {
  all: (..._args: unknown[]) => unknown;
  get: (..._args: unknown[]) => unknown;
  run: (..._args: unknown[]) => unknown;
};

type StubDb = {
  prepare: (_sql: string) => StubStmt;
};

function createStubDb(): StubDb {
  return {
    prepare() {
      return {
        all: () => [],
        get: () => undefined,
        run: () => undefined,
      };
    },
  };
}

function createReq(authorization?: string) {
  return {
    header(name: string) {
      if (name.toLowerCase() === "authorization") return authorization;
      return undefined;
    },
  };
}

function createRes(): FakeRes {
  return {
    statusCode: 200,
    payload: null,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.payload = body;
      return this;
    },
  };
}

describe("new route authentication hardening", () => {
  it("adds auth middleware for /api/ops/servers and rejects unauthorized requests", () => {
    const middlewares = new Map<string, Handler>();
    const app = {
      use(path: string, handler: Handler) {
        middlewares.set(path, handler);
        return this;
      },
      get() {
        return this;
      },
      post() {
        return this;
      },
      patch() {
        return this;
      },
      delete() {
        return this;
      },
    };

    registerServerManagementRoutes({
      app: app as any,
      db: createStubDb() as any,
      nowMs: () => Date.now(),
      broadcast: () => undefined,
    } as any);

    const requireAuth = middlewares.get("/api/ops/servers");
    expect(requireAuth).toBeTypeOf("function");

    const res = createRes();
    let nextCalled = false;
    requireAuth?.(createReq(), res, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(res.payload).toEqual({ error: "unauthorized" });
  });

  it("adds auth middleware for /api/knowledge/docs and rejects invalid bearer token", () => {
    const middlewares = new Map<string, Handler>();
    const app = {
      use(path: string, handler: Handler) {
        middlewares.set(path, handler);
        return this;
      },
      get() {
        return this;
      },
      post() {
        return this;
      },
      patch() {
        return this;
      },
      delete() {
        return this;
      },
      put() {
        return this;
      },
    };

    registerDocsRoutes({
      app: app as any,
      db: createStubDb(),
      nowMs: () => Date.now(),
      appendTaskLog: () => undefined,
      taskWorktrees: new Map(),
    });

    const requireAuth = middlewares.get("/api/knowledge/docs");
    expect(requireAuth).toBeTypeOf("function");

    const res = createRes();
    let nextCalled = false;
    requireAuth?.(createReq("Bearer invalid-token"), res, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(res.payload).toEqual({ error: "unauthorized" });
  });

  it("adds auth middleware for /api/operations and rejects unauthorized requests", () => {
    const middlewares = new Map<string, Handler>();
    const app = {
      use(path: string, handler: Handler) {
        middlewares.set(path, handler);
        return this;
      },
      get() {
        return this;
      },
      post() {
        return this;
      },
      patch() {
        return this;
      },
      delete() {
        return this;
      },
    };

    registerOperationsRoutes({
      app: app as any,
      db: createStubDb() as any,
      nowMs: () => Date.now(),
      broadcast: () => undefined,
      activeProcesses: new Map(),
      killPidTree: () => undefined,
      stopProgressTimer: () => undefined,
      endTaskExecutionSession: () => undefined,
      clearTaskWorkflowState: () => undefined,
    } as any);

    const requireAuth = middlewares.get("/api/operations");
    expect(requireAuth).toBeTypeOf("function");

    const res = createRes();
    let nextCalled = false;
    requireAuth?.(createReq(), res, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(res.payload).toEqual({ error: "unauthorized" });
  });

  it("guards design-parser endpoints with route-level requireAuth", () => {
    const postHandlers = new Map<string, Handler[]>();
    const getHandlers = new Map<string, Handler[]>();
    const app = {
      post(path: string, ...handlers: Handler[]) {
        postHandlers.set(path, handlers);
        return this;
      },
      get(path: string, ...handlers: Handler[]) {
        getHandlers.set(path, handlers);
        return this;
      },
    };

    registerDesignParserRoutes({
      app: app as any,
      db: createStubDb() as any,
      normalizeTextField: (value: unknown) => (typeof value === "string" ? value.trim() : ""),
    } as any);

    const parseRefHandlers = postHandlers.get("/api/design/parse-reference");
    const designAssetsHandlers = getHandlers.get("/api/tasks/:id/design-assets");
    expect(parseRefHandlers?.length).toBeGreaterThanOrEqual(2);
    expect(designAssetsHandlers?.length).toBeGreaterThanOrEqual(2);

    const parseRefAuth = parseRefHandlers?.[0];
    const designAssetsAuth = designAssetsHandlers?.[0];

    const resA = createRes();
    let nextA = false;
    parseRefAuth?.(createReq(), resA, () => {
      nextA = true;
    });
    expect(nextA).toBe(false);
    expect(resA.statusCode).toBe(401);
    expect(resA.payload).toEqual({ error: "unauthorized" });

    const resB = createRes();
    let nextB = false;
    designAssetsAuth?.(createReq("Bearer invalid-token"), resB, () => {
      nextB = true;
    });
    expect(nextB).toBe(false);
    expect(resB.statusCode).toBe(401);
    expect(resB.payload).toEqual({ error: "unauthorized" });
  });
});
