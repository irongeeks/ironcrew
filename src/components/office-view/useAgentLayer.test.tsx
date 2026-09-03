import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useRef, type MutableRefObject } from "react";
import type { Agent } from "../../types";

// Stub pixi.js so jsdom doesn't trip on canvas/WebGL globals.
vi.mock("pixi.js", () => {
  class FakeContainer {
    label = "";
    interactive = false;
    cursor = "";
    x = 0;
    y = 0;
    children: unknown[] = [];
    addChild(c: unknown) {
      this.children.push(c);
    }
    on() {}
    destroy() {}
  }
  class FakeSprite {
    label = "";
    width = 0;
    height = 0;
    anchor = { set: () => undefined };
    texture = { source: { scaleMode: "" } };
    constructor(_tex?: unknown) {}
  }
  class FakeGraphics {
    label = "";
    circle() {
      return this;
    }
    fill() {
      return this;
    }
  }
  class FakeText {
    label = "";
    anchor = { set: () => undefined };
    x = 0;
    y = 0;
    constructor(opts?: { text?: string }) {
      // Test hook: simulate a downstream sprite-construction failure for one agent
      // by making Text construction throw when the upper-cased first name token
      // contains the BOOM_TOKEN marker. This bypasses the inline try/catch in
      // useAgentLayer (which only wraps the loadCharWalkFrames await) and lets
      // us assert that the new outer Promise.all().catch() isolates the failure.
      if (opts && typeof opts.text === "string" && opts.text.includes("BOOMTOKEN")) {
        throw new Error("text-construct boom");
      }
    }
  }
  return {
    Application: class {},
    Container: FakeContainer,
    Graphics: FakeGraphics,
    Sprite: FakeSprite,
    Text: FakeText,
    Rectangle: class {},
    TextureStyle: class {},
  };
});

// Mock sprite loader so we can deterministically reject for one agent.
const loadCharWalkFramesMock = vi.fn();
vi.mock("./agentSprites", () => ({
  loadCharWalkFrames: (idx: number) => loadCharWalkFramesMock(idx),
}));

vi.mock("../AgentAvatar", () => ({
  resolveAgentCharacterIndex: (agent: { sprite_number?: number | null }) => agent.sprite_number ?? 0,
}));

// Import AFTER mocks so they take effect.
// eslint-disable-next-line import/first
import { useAgentLayer } from "./useAgentLayer";
// eslint-disable-next-line import/first
import type { AgentAnimState } from "./agentSprites";
// eslint-disable-next-line import/first
import { Container, type Application } from "pixi.js";

function makeAgent(overrides: Partial<Agent> & { id: string }): Agent {
  return {
    id: overrides.id,
    name: overrides.name ?? `Agent ${overrides.id}`,
    name_ko: overrides.name_ko ?? overrides.name ?? `Agent ${overrides.id}`,
    department_id: overrides.department_id ?? null,
    role: overrides.role ?? "junior",
    cli_provider: overrides.cli_provider ?? "claude",
    avatar_emoji: overrides.avatar_emoji ?? "🙂",
    sprite_number: overrides.sprite_number ?? 0,
    personality: overrides.personality ?? null,
    status: overrides.status ?? "idle",
    current_task_id: overrides.current_task_id ?? null,
    created_at: overrides.created_at ?? 0,
  };
}

interface HookEnv {
  appRef: MutableRefObject<Application | null>;
  worldRef: MutableRefObject<Container | null>;
  agentLayerRef: MutableRefObject<Container | null>;
  agentSpritesRef: MutableRefObject<Map<string, Container>>;
  agentAnimRef: MutableRefObject<Map<string, AgentAnimState>>;
  onSelectAgentRef: MutableRefObject<(agent: Agent) => void>;
}

function useEnv(): HookEnv {
  // appRef just needs to be truthy.
  const appRef = useRef({} as Application);
  const worldRef = useRef<Container | null>(new Container());
  const agentLayerRef = useRef<Container | null>(new Container());
  const agentSpritesRef = useRef<Map<string, Container>>(new Map());
  const agentAnimRef = useRef<Map<string, AgentAnimState>>(new Map());
  const onSelectAgentRef = useRef<(agent: Agent) => void>(() => undefined);
  return { appRef, worldRef, agentLayerRef, agentSpritesRef, agentAnimRef, onSelectAgentRef };
}

const getAgentTarget = () => ({ x: 0, y: 0, seatDirection: null });

const flushMicrotasks = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("useAgentLayer per-agent failure isolation (T-007)", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    loadCharWalkFramesMock.mockReset();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("loads other agents when one sprite-load throws unexpectedly, and logs the error", async () => {
    const okFrames = { down: ["a", "b", "c"], left: [], right: [], up: [] };
    loadCharWalkFramesMock.mockResolvedValue(okFrames);

    // Agent named with the BOOMTOKEN marker triggers a throw in the FakeText
    // constructor — which lives outside the existing inline try/catch in
    // useAgentLayer. This simulates a real-world failure (e.g. font/text
    // construction error) that previously would have produced an unhandled
    // promise rejection.
    const agents: Agent[] = [
      makeAgent({ id: "good1", name: "Good1", sprite_number: 1 }),
      makeAgent({ id: "bad", name: "BOOMTOKEN agent", sprite_number: 2 }),
      makeAgent({ id: "good2", name: "Good2", sprite_number: 3 }),
    ];

    const { result } = renderHook(() => {
      const env = useEnv();
      useAgentLayer(
        agents,
        false,
        env.appRef,
        env.worldRef,
        env.agentLayerRef,
        env.agentSpritesRef,
        env.agentAnimRef,
        env.onSelectAgentRef,
        getAgentTarget,
      );
      return env;
    });

    // Allow async sprite-load chain to settle.
    await flushMicrotasks();
    await flushMicrotasks();

    const sprites = result.current.agentSpritesRef.current;
    // "good1" and "good2" must still have been registered despite the bad agent throwing.
    expect(sprites.has("good1")).toBe(true);
    expect(sprites.has("good2")).toBe(true);

    // Error must have been logged with the failing agent's id surfaced.
    expect(errorSpy).toHaveBeenCalled();
    const calls = errorSpy.mock.calls.map((args) => String(args[0] ?? ""));
    expect(calls.some((msg) => /useAgentLayer/.test(msg) && /bad/.test(msg))).toBe(true);
  });

  it("happy path: all agents register and no error is logged", async () => {
    const okFrames = { down: ["a", "b", "c"], left: [], right: [], up: [] };
    loadCharWalkFramesMock.mockResolvedValue(okFrames);

    const agents: Agent[] = [makeAgent({ id: "a1", sprite_number: 1 }), makeAgent({ id: "a2", sprite_number: 2 })];

    const { result } = renderHook(() => {
      const env = useEnv();
      useAgentLayer(
        agents,
        false,
        env.appRef,
        env.worldRef,
        env.agentLayerRef,
        env.agentSpritesRef,
        env.agentAnimRef,
        env.onSelectAgentRef,
        getAgentTarget,
      );
      return env;
    });

    await flushMicrotasks();
    await flushMicrotasks();

    expect(result.current.agentSpritesRef.current.has("a1")).toBe(true);
    expect(result.current.agentSpritesRef.current.has("a2")).toBe(true);
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
