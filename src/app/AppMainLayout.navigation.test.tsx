import { useState, type ComponentProps, type ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { View } from "./types";
import AppMainLayout from "./AppMainLayout";

vi.mock("../ironcrew/CommandCenterView", () => ({
  CommandCenterView: ({ initialView, newMissionRequest }: { initialView: string; newMissionRequest: number }) => {
    const [draft, setDraft] = useState("");
    return (
      <section data-testid="canonical-company" data-view={initialView} data-mission={newMissionRequest}>
        <label>
          CEO draft
          <input value={draft} onChange={(event) => setDraft(event.target.value)} />
        </label>
      </section>
    );
  },
}));
vi.mock("../ironcrew/IdentityGate", () => ({
  IdentityGate: ({ children }: { children: ReactNode }) => (
    <>
      <div>Signed in</div>
      {children}
    </>
  ),
}));
vi.mock("../components/IronCrewTopBar", () => ({
  default: ({ onChangeView, onNewMission }: { onChangeView: (view: View) => void; onNewMission: () => void }) => (
    <nav>
      <button onClick={() => onChangeView("office")}>Office</button>
      <button onClick={() => onChangeView("tasks")}>Tasks</button>
      <button onClick={() => onChangeView("command")}>Command</button>
      <button onClick={onNewMission}>New Mission</button>
    </nav>
  ),
}));
vi.mock("./useOfficePackResolution", () => ({
  useOfficePackResolution: () => ({
    officePresentation: { agents: [], departments: [] },
    officePackKey: "development",
  }),
}));
vi.mock("../hooks/useMobile", () => ({ useMobile: () => ({ isMobile: false }) }));
vi.mock("./MobileHeader", () => ({ default: () => null }));
vi.mock("../components/RetroSidebar", () => ({ default: () => null }));
vi.mock("../components/AgentManager", () => ({ default: () => null }));
vi.mock("../components/SkillsLibrary", () => ({ default: () => null }));
vi.mock("../components/SettingsPanel", () => ({ default: () => null }));
vi.mock("../components/OperationsCenter", () => ({ default: () => null }));
vi.mock("../components/ProjectsView", () => ({ default: () => <p>Legacy projects</p> }));
vi.mock("../components/schedules/SchedulesView", () => ({ default: () => null }));
vi.mock("../components/workflow-editor/WorkflowEditorPage", () => ({ WorkflowEditorPage: () => null }));

function Shell({ initialView = "office" }: { initialView?: View }) {
  const [view, setView] = useState<View>(initialView);
  const props = {
    view,
    setView,
    labels: { uiLanguage: "de" },
    settings: { language: "de" },
    setMobileNavOpen: vi.fn(),
    setMobileHeaderMenuOpen: vi.fn(),
    onCloseChat: vi.fn(),
    departments: [],
    agents: [],
    tasks: [],
    subtasks: [],
    customRoomThemes: {},
  } as unknown as ComponentProps<typeof AppMainLayout>;
  return <AppMainLayout {...props} />;
}

describe("canonical company navigation", () => {
  it("keeps the same company and CEO draft while switching Office, Tasks and Command", () => {
    render(<Shell />);
    const company = screen.getByTestId("canonical-company");
    expect(company).toHaveAttribute("data-view", "office");
    fireEvent.change(screen.getByLabelText("CEO draft"), { target: { value: "Ship the website" } });
    fireEvent.click(screen.getByRole("button", { name: "Tasks" }));
    expect(screen.getByTestId("canonical-company")).toBe(company);
    expect(company).toHaveAttribute("data-view", "tasks");
    fireEvent.click(screen.getByRole("button", { name: "Command" }));
    expect(company).toHaveAttribute("data-view", "office");
    expect(company).toHaveAttribute("data-mission", "1");
    expect(screen.getByLabelText("CEO draft")).toHaveValue("Ship the website");
    expect(screen.getAllByRole("main")).toHaveLength(1);
  });

  it("opens the canonical mission composer from a different screen and on repeated clicks", () => {
    render(<Shell initialView="projects" />);
    expect(screen.queryByTestId("canonical-company")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "New Mission" }));
    expect(screen.getByTestId("canonical-company")).toHaveAttribute("data-mission", "1");
    fireEvent.click(screen.getByRole("button", { name: "New Mission" }));
    expect(screen.getByTestId("canonical-company")).toHaveAttribute("data-mission", "2");
    expect(screen.queryByText("Legacy projects")).not.toBeInTheDocument();
  });
});
