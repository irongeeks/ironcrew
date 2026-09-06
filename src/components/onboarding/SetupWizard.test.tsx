import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import SetupWizard from "./SetupWizard";
import { DEFAULT_SETTINGS, type CliStatusMap, type CliToolStatus } from "../../types";
import { LANGUAGE_STORAGE_KEY } from "../../i18n";
import { getCliStatus, getSetupStatus, saveSettingsPatch } from "../../api/messaging-runtime-oauth";

vi.mock("../../api/messaging-runtime-oauth", () => ({
  getCliStatus: vi.fn(),
  getSetupStatus: vi.fn(),
  saveSettingsPatch: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../cli-auth/CliAuthModal", () => ({ default: () => null }));

const unavailableTool: CliToolStatus = { installed: false, version: null, authenticated: false, authHint: "" };
const cliStatus: CliStatusMap = {
  claude: unavailableTool,
  codex: unavailableTool,
  gemini: unavailableTool,
  opencode: unavailableTool,
  copilot: unavailableTool,
  antigravity: unavailableTool,
  api: unavailableTool,
  openclaw: unavailableTool,
};

describe("SetupWizard language", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    vi.mocked(getCliStatus).mockResolvedValue(cliStatus);
    vi.mocked(getSetupStatus).mockResolvedValue({
      status: "partial",
      required_ok: true,
      optional_ok: false,
      onboarding_completed: false,
      checks: { knowledge_vault_configured: { ok: false, detail: "No knowledge vault configured (optional)" } },
    });
  });

  it("uses the configured German language throughout onboarding and saves it", async () => {
    const onComplete = vi.fn();
    render(
      <SetupWizard settings={{ ...DEFAULT_SETTINGS, language: "de" }} cliStatus={cliStatus} onComplete={onComplete} />,
    );
    expect(screen.getByRole("heading", { name: "Willkommen bei IronCrew" })).toBeInTheDocument();
    expect(screen.getAllByRole("option").map((option) => option.getAttribute("value"))).toEqual(["en", "de"]);
    fireEvent.click(screen.getByRole("button", { name: "Weiter →" }));
    expect(screen.getByRole("heading", { name: "KI-Anbieter auswählen" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Weiter →" }));
    expect(screen.getByRole("heading", { name: "Optionale Integrationen" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Weiter →" }));
    expect(screen.getByRole("heading", { name: "Wissensbasis" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Überspringen" }));
    await screen.findByRole("heading", { name: "Alles bereit!" });
    expect(screen.getByText("Kein Wissens-Vault eingerichtet (optional)")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Büro öffnen →" }));
    await waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
    expect(saveSettingsPatch).toHaveBeenCalledWith(
      expect.objectContaining({ language: "de", onboarding_completed: true }),
    );
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe("de");
  });

  it("changes all step text immediately when English is selected", async () => {
    render(
      <SetupWizard settings={{ ...DEFAULT_SETTINGS, language: "de" }} cliStatus={cliStatus} onComplete={vi.fn()} />,
    );
    fireEvent.change(screen.getByRole("combobox", { name: "Sprache" }), { target: { value: "en" } });
    expect(screen.getByRole("heading", { name: "Welcome to IronCrew" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Company Name" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next →" })).toBeInTheDocument();
    await waitFor(() => expect(getSetupStatus).toHaveBeenCalledOnce());
  });
});
