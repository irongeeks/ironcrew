import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import KnowledgeStep from "./KnowledgeStep";
import { createDocsProvider, testDocsProvider } from "../../api/knowledge-docs";
import { saveSettingsPatch } from "../../api/messaging-runtime-oauth";

vi.mock("../../api/knowledge-docs", () => ({
  createDocsProvider: vi.fn(),
  testDocsProvider: vi.fn(),
  updateDocsProvider: vi.fn(),
  deleteDocsProvider: vi.fn(),
}));
vi.mock("../../api/messaging-runtime-oauth", () => ({
  saveSettingsPatch: vi.fn(),
}));

const mockedCreate = vi.mocked(createDocsProvider);
const mockedTest = vi.mocked(testDocsProvider);
const mockedSave = vi.mocked(saveSettingsPatch);

describe("KnowledgeStep", () => {
  const onNext = vi.fn();
  const onBack = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders vault path input with default value containing 'workspaces/knowledge'", () => {
    render(<KnowledgeStep onNext={onNext} onBack={onBack} />);
    const input = screen.getByDisplayValue("workspaces/knowledge");
    expect(input).toBeTruthy();
  });

  it("renders auto-bind checkbox checked by default", () => {
    render(<KnowledgeStep onNext={onNext} onBack={onBack} />);
    const checkbox = screen.getByRole("checkbox");
    expect(checkbox).toBeChecked();
  });

  it("renders Skip and Continue buttons", () => {
    render(<KnowledgeStep onNext={onNext} onBack={onBack} />);
    expect(screen.getByText("Skip")).toBeTruthy();
    expect(screen.getByText("Continue")).toBeTruthy();
  });

  it("renders Test Connection button", () => {
    render(<KnowledgeStep onNext={onNext} onBack={onBack} />);
    expect(screen.getByText("Test Connection")).toBeTruthy();
  });

  it("calls onBack when Back is clicked", () => {
    render(<KnowledgeStep onNext={onNext} onBack={onBack} />);
    fireEvent.click(screen.getByText("← Back"));
    expect(onBack).toHaveBeenCalledOnce();
  });

  it("calls onNext when Skip is clicked", () => {
    render(<KnowledgeStep onNext={onNext} onBack={onBack} />);
    fireEvent.click(screen.getByText("Skip"));
    expect(onNext).toHaveBeenCalledOnce();
  });

  it("creates provider and tests on Test Connection click — shows N notes found", async () => {
    mockedCreate.mockResolvedValue({
      id: "prov-1",
      name: "Obsidian Vault",
      providerType: "obsidian",
      vaultPath: "workspaces/knowledge",
      enabled: true,
      readOnly: false,
      metadata: null,
      createdAt: 0,
      updatedAt: 0,
    });
    mockedTest.mockResolvedValue({ ok: true, reachable: true, previewCount: 42 });

    render(<KnowledgeStep onNext={onNext} onBack={onBack} />);
    fireEvent.click(screen.getByText("Test Connection"));

    await waitFor(() => {
      expect(screen.getByText(/42 notes found/)).toBeTruthy();
    });

    expect(mockedCreate).toHaveBeenCalledWith({
      name: "Obsidian Vault",
      vaultPath: "workspaces/knowledge",
      enabled: true,
      readOnly: false,
    });
    expect(mockedTest).toHaveBeenCalledWith("prov-1");
  });

  it("enables Continue after successful test", async () => {
    mockedCreate.mockResolvedValue({
      id: "prov-1",
      name: "Obsidian Vault",
      providerType: "obsidian",
      vaultPath: "workspaces/knowledge",
      enabled: true,
      readOnly: false,
      metadata: null,
      createdAt: 0,
      updatedAt: 0,
    });
    mockedTest.mockResolvedValue({ ok: true, reachable: true, previewCount: 10 });

    render(<KnowledgeStep onNext={onNext} onBack={onBack} />);

    const continueBtn = screen.getByText("Continue");
    expect(continueBtn).toBeDisabled();

    fireEvent.click(screen.getByText("Test Connection"));

    await waitFor(() => {
      expect(screen.getByText("Continue")).not.toBeDisabled();
    });
  });

  it("saves auto-bind setting and calls onNext on Continue", async () => {
    mockedCreate.mockResolvedValue({
      id: "prov-1",
      name: "Obsidian Vault",
      providerType: "obsidian",
      vaultPath: "workspaces/knowledge",
      enabled: true,
      readOnly: false,
      metadata: null,
      createdAt: 0,
      updatedAt: 0,
    });
    mockedTest.mockResolvedValue({ ok: true, reachable: true, previewCount: 5 });
    mockedSave.mockResolvedValue(undefined);

    render(<KnowledgeStep onNext={onNext} onBack={onBack} />);
    fireEvent.click(screen.getByText("Test Connection"));

    await waitFor(() => {
      expect(screen.getByText("Continue")).not.toBeDisabled();
    });

    fireEvent.click(screen.getByText("Continue"));

    await waitFor(() => {
      expect(mockedSave).toHaveBeenCalledWith({ knowledgeAutoBindDefault: true });
      expect(onNext).toHaveBeenCalledOnce();
    });
  });

  it("shows error when test fails", async () => {
    mockedCreate.mockResolvedValue({
      id: "prov-1",
      name: "Obsidian Vault",
      providerType: "obsidian",
      vaultPath: "workspaces/knowledge",
      enabled: true,
      readOnly: false,
      metadata: null,
      createdAt: 0,
      updatedAt: 0,
    });
    mockedTest.mockResolvedValue({ ok: false, reachable: false, error: "Vault not found" });

    render(<KnowledgeStep onNext={onNext} onBack={onBack} />);
    fireEvent.click(screen.getByText("Test Connection"));

    await waitFor(() => {
      expect(screen.getByText(/Vault not found/)).toBeTruthy();
    });
  });

  it("resets test state when path changes after success", async () => {
    mockedCreate.mockResolvedValue({
      id: "prov-1",
      name: "Obsidian Vault",
      providerType: "obsidian",
      vaultPath: "workspaces/knowledge",
      enabled: true,
      readOnly: false,
      metadata: null,
      createdAt: 0,
      updatedAt: 0,
    });
    mockedTest.mockResolvedValue({ ok: true, reachable: true, previewCount: 7 });

    render(<KnowledgeStep onNext={onNext} onBack={onBack} />);
    fireEvent.click(screen.getByText("Test Connection"));

    await waitFor(() => {
      expect(screen.getByText(/7 notes found/)).toBeTruthy();
    });

    const input = screen.getByDisplayValue("workspaces/knowledge");
    fireEvent.change(input, { target: { value: "workspaces/other" } });

    expect(screen.queryByText(/7 notes found/)).toBeNull();
    expect(screen.getByText("Continue")).toBeDisabled();
  });

  it("renders Obsidian logo SVG", () => {
    render(<KnowledgeStep onNext={onNext} onBack={onBack} />);
    expect(screen.getByRole("img", { name: "Obsidian logo" })).toBeTruthy();
  });

  it("renders Obsidian Sync hint text", () => {
    render(<KnowledgeStep onNext={onNext} onBack={onBack} />);
    expect(screen.getByText(/Using Obsidian Sync\?/)).toBeTruthy();
  });
});
