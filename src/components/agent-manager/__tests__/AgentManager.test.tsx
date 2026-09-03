import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// Mock child components
vi.mock("../AgentsTab", () => ({
  default: ({ agents, sortedAgents }: { agents: unknown[]; sortedAgents: unknown[] }) => (
    <div data-testid="agents-tab">
      AgentsTab ({agents.length} agents, {sortedAgents.length} sorted)
    </div>
  ),
}));

vi.mock("../DepartmentsTab", () => ({
  default: () => <div data-testid="departments-tab">DepartmentsTab</div>,
}));

vi.mock("../AgentFormModal", () => ({
  default: () => <div data-testid="agent-form-modal">AgentFormModal</div>,
}));

vi.mock("../DepartmentFormModal", () => ({
  default: () => <div data-testid="department-form-modal">DepartmentFormModal</div>,
}));

vi.mock("../EmojiPicker", () => ({
  StackedSpriteIcon: ({ sprites }: { sprites: [number, number] }) => (
    <span data-testid="stacked-sprite-icon">{sprites.join(",")}</span>
  ),
}));

// Mock hooks
vi.mock("../useIsolatedPackPersist", () => ({
  useIsolatedPackPersist: () => ({
    persistIsolatedProfile: vi.fn(),
  }),
}));

vi.mock("../useAgentCrud", () => ({
  useAgentCrud: () => ({
    modalAgent: null,
    showModal: false,
    form: {},
    setForm: vi.fn(),
    saving: false,
    confirmDeleteId: null,
    setConfirmDeleteId: vi.fn(),
    servers: [],
    openCreate: vi.fn(),
    openEdit: vi.fn(),
    closeModal: vi.fn(),
    handleSave: vi.fn(),
    handleDelete: vi.fn(),
    handleQuickAssignTask: vi.fn(),
    handleQuickMessageAgent: vi.fn(),
  }),
}));

vi.mock("../useDeptReorder", () => ({
  useDeptReorder: () => ({
    deptOrder: [],
    deptOrderDirty: false,
    reorderSaving: false,
    draggingDeptId: null,
    dragOverDeptId: null,
    dragOverPosition: null,
    moveDept: vi.fn(),
    saveDeptOrder: vi.fn(),
    resetDeptOrder: vi.fn(),
    handleDeptDragStart: vi.fn(),
    handleDeptDragOver: vi.fn(),
    handleDeptDrop: vi.fn(),
    clearDeptDragState: vi.fn(),
  }),
}));

// Mock i18n
vi.mock("../../../i18n", () => ({
  useI18n: () => ({
    t: ({ en }: { en: string }) => en,
    locale: "en",
  }),
}));

// Mock office-workflow-pack
vi.mock("../../../app/office-workflow-pack", () => ({
  normalizeOfficeWorkflowPack: (key: string) => key,
}));

// Mock AgentAvatar
vi.mock("../../AgentAvatar", () => ({
  buildSpriteMap: () => new Map(),
}));

// Mock utils
vi.mock("../utils", () => ({
  pickRandomSpritePair: () => [0, 1] as [number, number],
}));

import AgentManager from "../../AgentManager";

const defaultProps = {
  agents: [],
  departments: [],
  onAgentsChange: vi.fn(),
  activeOfficeWorkflowPack: "development" as const,
  onSaveOfficePackProfile: vi.fn().mockResolvedValue(undefined),
};

describe("AgentManager", () => {
  it("renders the main container", () => {
    const { container } = render(<AgentManager {...defaultProps} />);
    expect(container.firstChild).toBeTruthy();
    // Main container is a div with max-w-4xl
    const mainDiv = container.firstChild as HTMLElement;
    expect(mainDiv.tagName).toBe("DIV");
    expect(mainDiv.className).toContain("max-w-4xl");
  });

  it("renders action buttons (Add Dept and Hire Agent)", () => {
    render(<AgentManager {...defaultProps} />);
    expect(screen.getByText(/Add Dept/)).toBeInTheDocument();
    expect(screen.getByText(/Hire Agent/)).toBeInTheDocument();
  });

  it("renders the sub-tab toggles (Agents and Departments)", () => {
    render(<AgentManager {...defaultProps} />);
    expect(screen.getByText("Agents")).toBeInTheDocument();
    expect(screen.getByText("Departments")).toBeInTheDocument();
  });

  it("shows AgentsTab by default with empty agents", () => {
    render(<AgentManager {...defaultProps} />);
    expect(screen.getByTestId("agents-tab")).toBeInTheDocument();
    expect(screen.getByText("AgentsTab (0 agents, 0 sorted)")).toBeInTheDocument();
  });

  it("shows empty state when no agents are provided", () => {
    render(<AgentManager {...defaultProps} agents={[]} departments={[]} />);
    // The AgentsTab is rendered with 0 agents
    expect(screen.getByText("AgentsTab (0 agents, 0 sorted)")).toBeInTheDocument();
    // Departments tab should not show by default
    expect(screen.queryByTestId("departments-tab")).not.toBeInTheDocument();
  });

  it("passes agents down to AgentsTab correctly", () => {
    const agents = [
      {
        id: "a1",
        name: "Alice",
        name_ko: "Alice",
        name_ja: "",
        name_zh: "",
        department_id: "d1",
        role: "developer",
        cli_provider: "claude",
        status: "idle",
      },
      {
        id: "a2",
        name: "Bob",
        name_ko: "Bob",
        name_ja: "",
        name_zh: "",
        department_id: "d1",
        role: "designer",
        cli_provider: "gemini",
        status: "idle",
      },
    ] as never[];

    render(<AgentManager {...defaultProps} agents={agents} />);
    expect(screen.getByText("AgentsTab (2 agents, 2 sorted)")).toBeInTheDocument();
  });

  it("does not render modals by default", () => {
    render(<AgentManager {...defaultProps} />);
    expect(screen.queryByTestId("agent-form-modal")).not.toBeInTheDocument();
    expect(screen.queryByTestId("department-form-modal")).not.toBeInTheDocument();
  });
});
