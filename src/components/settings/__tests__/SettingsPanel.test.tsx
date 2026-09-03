import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../../../hooks/useMobile", () => ({
  useMobile: () => ({ isMobile: false }),
}));

// Mock all tab content components
vi.mock("../GeneralSettingsTab", () => ({
  default: () => <div data-testid="general-tab">GeneralSettingsTab</div>,
}));
vi.mock("../CliSettingsTab", () => ({
  default: () => <div data-testid="cli-tab">CliSettingsTab</div>,
}));
vi.mock("../OAuthSettingsTab", () => ({
  default: () => <div data-testid="oauth-tab">OAuthSettingsTab</div>,
}));
vi.mock("../ApiSettingsTab", () => ({
  default: () => <div data-testid="api-tab">ApiSettingsTab</div>,
}));
vi.mock("../GatewaySettingsTab", () => ({
  default: () => <div data-testid="gateway-tab">GatewaySettingsTab</div>,
}));
vi.mock("../KnowledgeSettingsTab", () => ({
  default: () => <div data-testid="knowledge-tab">KnowledgeSettingsTab</div>,
}));
vi.mock("../ComfyUiSettingsTab", () => ({
  default: () => <div data-testid="comfyui-tab">ComfyUiSettingsTab</div>,
}));
vi.mock("../ConnectorSettingsTab", () => ({
  default: () => <div data-testid="connectors-tab">ConnectorSettingsTab</div>,
}));
vi.mock("../McpSettingsTab", () => ({
  default: () => <div data-testid="mcp-tab">McpSettingsTab</div>,
}));
vi.mock("../ServersSettingsTab", () => ({
  default: () => <div data-testid="servers-tab">ServersSettingsTab</div>,
}));
vi.mock("../WorkflowPackSettingsTab", () => ({
  default: () => <div data-testid="workflow-packs-tab">WorkflowPackSettingsTab</div>,
}));
vi.mock("../ObservabilitySettingsTab", () => ({
  default: () => <div data-testid="observability-tab">ObservabilitySettingsTab</div>,
}));

// Mock useApiProvidersState hook
vi.mock("../useApiProvidersState", () => ({
  useApiProvidersState: () => ({}),
}));

// Mock API calls
vi.mock("../../../api", () => ({
  getOAuthStatus: vi.fn().mockResolvedValue({ providers: {} }),
  getOAuthModels: vi.fn().mockResolvedValue({}),
  getCliModels: vi.fn().mockResolvedValue({}),
}));

import SettingsPanel from "../../SettingsPanel";

const defaultProps = {
  settings: { language: "en" } as never,
  cliStatus: null,
  agents: [],
  onSave: vi.fn(),
  onRefreshCli: vi.fn(),
};

describe("SettingsPanel", () => {
  it("renders tab navigation with multiple tabs", () => {
    render(<SettingsPanel {...defaultProps} />);

    expect(screen.getByText("General")).toBeInTheDocument();
    expect(screen.getByText("CLI Tools")).toBeInTheDocument();
    expect(screen.getByText("OAuth")).toBeInTheDocument();
    expect(screen.getByText("API")).toBeInTheDocument();
    expect(screen.getByText("Channel")).toBeInTheDocument();
    expect(screen.getByText("Knowledge")).toBeInTheDocument();
    expect(screen.getByText("ComfyUI")).toBeInTheDocument();
    expect(screen.getByText("Connectors")).toBeInTheDocument();
    expect(screen.getByText("MCP")).toBeInTheDocument();
    expect(screen.getByText("Servers")).toBeInTheDocument();
    expect(screen.getByText("Workflow Packs")).toBeInTheDocument();
    expect(screen.getByText("Observability")).toBeInTheDocument();
  });

  it("shows General tab content by default", () => {
    render(<SettingsPanel {...defaultProps} />);

    expect(screen.getByTestId("general-tab")).toBeInTheDocument();
    expect(screen.queryByTestId("cli-tab")).not.toBeInTheDocument();
    expect(screen.queryByTestId("api-tab")).not.toBeInTheDocument();
  });

  it("switches tabs on click", async () => {
    const user = userEvent.setup();
    render(<SettingsPanel {...defaultProps} />);

    // Default: General tab visible
    expect(screen.getByTestId("general-tab")).toBeInTheDocument();

    // Click CLI Tools tab
    await user.click(screen.getByText("CLI Tools"));
    expect(screen.getByTestId("cli-tab")).toBeInTheDocument();
    expect(screen.queryByTestId("general-tab")).not.toBeInTheDocument();

    // Click API tab
    await user.click(screen.getByText("API"));
    expect(screen.getByTestId("api-tab")).toBeInTheDocument();
    expect(screen.queryByTestId("cli-tab")).not.toBeInTheDocument();
  });
});
