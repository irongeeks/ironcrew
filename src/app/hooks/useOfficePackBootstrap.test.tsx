import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { useState } from "react";
import type { Agent, CompanySettings, Department } from "../../types";
import type { RoomThemeMap } from "../types";
import { mergeSettingsWithDefaults } from "../utils";
import { useOfficePackBootstrap } from "./useOfficePackBootstrap";

vi.mock("../../api", () => ({
  saveSettingsPatch: vi.fn(() => Promise.resolve()),
  getDepartments: vi.fn(() => Promise.resolve([])),
  getAgents: vi.fn(() => Promise.resolve([])),
  getSettings: vi.fn(() => Promise.resolve({})),
}));

import * as api from "../../api";

const baseSettings: CompanySettings = mergeSettingsWithDefaults({
  language: "en",
  officeWorkflowPack: "development",
});

interface HarnessProps {
  initialSettings?: CompanySettings;
  departments?: Department[];
  agents?: Agent[];
  customRoomThemes?: RoomThemeMap;
}

function Harness({
  initialSettings = baseSettings,
  departments = [],
  agents = [],
  customRoomThemes = {},
}: HarnessProps) {
  const [settings, setSettings] = useState<CompanySettings>(initialSettings);
  const [departmentsState, setDepartmentsState] = useState<Department[]>(departments);
  const [agentsState, setAgentsState] = useState<Agent[]>(agents);

  const { officePackBootstrappingLabel, handleOfficeWorkflowPackChange } = useOfficePackBootstrap({
    settings,
    setSettings,
    departments: departmentsState,
    setDepartments: setDepartmentsState,
    agents: agentsState,
    setAgents: setAgentsState,
    customRoomThemes,
  });

  return (
    <div>
      <span data-testid="label">{officePackBootstrappingLabel ?? "(none)"}</span>
      <span data-testid="pack">{settings.officeWorkflowPack ?? "(unset)"}</span>
      <button data-testid="change-dev" onClick={() => handleOfficeWorkflowPackChange("development")} />
      <button data-testid="change-research" onClick={() => handleOfficeWorkflowPackChange("web_research_report")} />
    </div>
  );
}

describe("useOfficePackBootstrap", () => {
  beforeEach(() => {
    vi.mocked(api.saveSettingsPatch).mockClear();
    vi.mocked(api.getDepartments).mockClear();
    vi.mocked(api.getAgents).mockClear();
    vi.mocked(api.getSettings).mockClear();
    vi.mocked(api.getDepartments).mockResolvedValue([]);
    vi.mocked(api.getAgents).mockResolvedValue([]);
    vi.mocked(api.getSettings).mockImplementation(
      () =>
        Promise.resolve(
          mergeSettingsWithDefaults({ officeWorkflowPack: "web_research_report" }),
        ) as unknown as ReturnType<typeof api.getSettings>,
    );
    vi.mocked(api.saveSettingsPatch).mockResolvedValue(undefined as unknown as void);
  });

  it("exposes a null bootstrap label initially", () => {
    render(<Harness />);
    expect(screen.getByTestId("label").textContent).toBe("(none)");
    expect(screen.getByTestId("pack").textContent).toBe("development");
  });

  it("does not show a bootstrap label when switching to the development pack", async () => {
    render(<Harness />);
    await act(async () => {
      screen.getByTestId("change-dev").click();
    });
    expect(screen.getByTestId("label").textContent).toBe("(none)");
    expect(api.saveSettingsPatch).toHaveBeenCalledWith(expect.objectContaining({ officeWorkflowPack: "development" }));
  });

  it("optimistically updates settings to the new pack and calls saveSettingsPatch", async () => {
    render(<Harness />);
    await act(async () => {
      screen.getByTestId("change-research").click();
    });
    expect(screen.getByTestId("pack").textContent).toBe("web_research_report");
    expect(api.saveSettingsPatch).toHaveBeenCalledTimes(1);
    expect(api.saveSettingsPatch).toHaveBeenCalledWith(
      expect.objectContaining({ officeWorkflowPack: "web_research_report" }),
    );
  });
});
