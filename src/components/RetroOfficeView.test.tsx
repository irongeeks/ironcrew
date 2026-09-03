import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import type { Agent, Department, ServerAllocation, ServerNode } from "../types";

// Inert hook mocks so we don't depend on Pixi/canvas runtime.
vi.mock("./office-view/useAgentPositions", () => ({
  useAgentPositions: () => ({
    getAgentTarget: () => ({ x: 0, y: 0, seatDirection: null }),
  }),
}));
vi.mock("./office-view/usePixiApp", () => ({ usePixiApp: () => undefined }));
vi.mock("./office-view/useAgentLayer", () => ({ useAgentLayer: () => undefined }));
vi.mock("./office-view/useServerLayer", () => ({ useServerLayer: () => undefined }));
vi.mock("./office-view/useShadowLayer", () => ({
  useShadowLayer: () => ({ updateShadows: () => undefined }),
}));
vi.mock("./office-view/useParticleLayer", () => ({
  useParticleLayer: () => ({ updateParticles: () => undefined }),
}));
// pixi.js is only imported for types in RetroOfficeView, but the office-view
// hooks pull it in — stub it so jsdom doesn't trip on WebGL globals if any
// transitive import is evaluated.
vi.mock("pixi.js", () => ({
  Application: class {},
  Container: class {},
  Graphics: class {},
  Rectangle: class {},
  Sprite: class {},
  Text: class {},
  TextureStyle: class {},
}));

// Import AFTER mocks so the mocks take effect.
// eslint-disable-next-line import/first
import RetroOfficeView from "./RetroOfficeView";

function makeDepartment(overrides: Partial<Department> = {}): Department {
  return {
    id: overrides.id ?? "dept-1",
    name: overrides.name ?? "Research",
    name_ko: overrides.name_ko ?? "리서치",
    name_ja: overrides.name_ja ?? null,
    name_zh: overrides.name_zh ?? null,
    icon: overrides.icon ?? "search",
    color: overrides.color ?? "#34D399",
    description: overrides.description ?? null,
    prompt: overrides.prompt ?? null,
    sort_order: overrides.sort_order ?? 0,
    created_at: overrides.created_at ?? 0,
    ...overrides,
  };
}

const departments: Department[] = [
  makeDepartment({ id: "dept-1", name: "Research" }),
  makeDepartment({ id: "dept-2", name: "Development", sort_order: 1 }),
  makeDepartment({ id: "dept-3", name: "Design", sort_order: 2 }),
];

const noopAgents: Agent[] = [];
const noopServers: ServerNode[] = [];
const noopAllocs: ServerAllocation[] = [];

interface RenderProps {
  onSelectDepartment?: (d: Department) => void;
  onSelectAgent?: (a: Agent) => void;
  onSelectServer?: (s: ServerNode | null) => void;
}

function renderView({
  onSelectDepartment = vi.fn(),
  onSelectAgent = vi.fn(),
  onSelectServer = vi.fn(),
}: RenderProps = {}) {
  return {
    onSelectDepartment,
    onSelectAgent,
    onSelectServer,
    ...render(
      <RetroOfficeView
        agents={noopAgents}
        departments={departments}
        servers={noopServers}
        serverAllocations={noopAllocs}
        onSelectAgent={onSelectAgent}
        onSelectServer={onSelectServer}
        onSelectDepartment={onSelectDepartment}
      />,
    ),
  };
}

describe("RetroOfficeView accessibility (E-006)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exposes the canvas wrapper as role=img with an informative aria-label", () => {
    renderView();
    const region = screen.getByRole("img", { name: /office/i });
    expect(region).toBeInTheDocument();
    expect(region.getAttribute("aria-label") ?? "").toMatch(/office/i);
  });

  it("renders a list of department buttons mirroring the canvas state", () => {
    renderView();
    const list = screen.getByRole("list", { name: /department/i });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(departments.length);
    for (const dept of departments) {
      const btn = within(list).getByRole("button", { name: new RegExp(dept.name, "i") });
      expect(btn).toBeInTheDocument();
    }
  });

  it("invokes onSelectDepartment when a hidden department button is activated", () => {
    const { onSelectDepartment } = renderView();
    const list = screen.getByRole("list", { name: /department/i });
    const btn = within(list).getByRole("button", { name: /Development/i });
    fireEvent.click(btn);
    expect(onSelectDepartment).toHaveBeenCalledTimes(1);
    expect(onSelectDepartment).toHaveBeenCalledWith(expect.objectContaining({ id: "dept-2", name: "Development" }));
  });

  it("renders the department list as visually hidden but focusable", () => {
    renderView();
    const list = screen.getByRole("list", { name: /department/i });
    // Either a sr-only utility class or inline visually-hidden styling is acceptable.
    const className = list.className ?? "";
    const inlineStyle = (list.getAttribute("style") ?? "").toLowerCase();
    const isSrOnly =
      /sr-only|visually-hidden/.test(className) ||
      (inlineStyle.includes("position: absolute") && /clip\s*:/.test(inlineStyle));
    expect(isSrOnly).toBe(true);

    // Focusable: buttons inside should not be aria-hidden or tabindex=-1
    const btn = within(list).getByRole("button", { name: /Research/i });
    expect(btn.getAttribute("aria-hidden")).not.toBe("true");
    expect(btn.getAttribute("tabindex")).not.toBe("-1");
  });

  it("uses the sr-only-focusable variant so the list reveals itself on focus (E-006 review)", () => {
    renderView();
    const list = screen.getByRole("list", { name: /department/i });
    // Class must be the focusable variant — the plain .sr-only would keep the
    // panel invisible while its children are tabbable (WCAG 2.4.7 violation).
    expect(list.className).toMatch(/\bsr-only-focusable\b/);
    expect(list.className).not.toMatch(/\bsr-only\b(?!-)/);

    // Focus a button and assert the wrapping <ul> matches :focus-within so
    // the CSS reveal rule applies for sighted keyboard users.
    const btn = within(list).getByRole("button", { name: /Research/i });
    btn.focus();
    expect(document.activeElement).toBe(btn);
    const wrapper = btn.closest("ul");
    expect(wrapper).not.toBeNull();
    expect(wrapper!.matches(":focus-within")).toBe(true);
  });
});
