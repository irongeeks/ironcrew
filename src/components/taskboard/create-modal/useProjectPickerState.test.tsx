import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectPickerState } from "./useProjectPickerState";

const apiMocks = vi.hoisted(() => ({
  browseProjectPath: vi.fn(),
  getProjectPathSuggestions: vi.fn(),
  getProjects: vi.fn(),
  isApiRequestError: vi.fn(),
  pickProjectPathNative: vi.fn(),
}));

vi.mock("../../../api", () => ({
  browseProjectPath: apiMocks.browseProjectPath,
  getProjectPathSuggestions: apiMocks.getProjectPathSuggestions,
  getProjects: apiMocks.getProjects,
  isApiRequestError: apiMocks.isApiRequestError,
  pickProjectPathNative: apiMocks.pickProjectPathNative,
}));

describe("useProjectPickerState native picker fallback", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    apiMocks.getProjects.mockResolvedValue({
      projects: [],
      page: 1,
      page_size: 50,
      total: 0,
      total_pages: 1,
    });
    apiMocks.getProjectPathSuggestions.mockResolvedValue([]);
    apiMocks.browseProjectPath.mockResolvedValue({
      current_path: "D:\\AI\\ironcrew",
      parent_path: "D:\\AI",
      entries: [],
      truncated: false,
    });
    apiMocks.isApiRequestError.mockImplementation((error: unknown) => {
      return Boolean((error as { __apiError?: boolean } | null)?.__apiError);
    });
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    vi.clearAllMocks();
  });

  it("opens in-app folder browser when native picker fails", async () => {
    const setFormFeedback = vi.fn();
    const setSubmitWithoutProjectPromptOpen = vi.fn();
    apiMocks.pickProjectPathNative.mockRejectedValue({
      __apiError: true,
      status: 500,
      code: "native_picker_failed",
    });

    const { result } = renderHook(() =>
      useProjectPickerState({
        unsupportedPathApiMessage: "unsupported",
        resolvePathHelperErrorMessage: () =>
          "OS folder picker is unavailable in this environment. Use in-app browser or manual input.",
        setFormFeedback,
        setSubmitWithoutProjectPromptOpen,
      }),
    );

    await waitFor(() => {
      expect(apiMocks.getProjects).toHaveBeenCalled();
    });

    act(() => {
      result.current.setCreateNewProjectMode(true);
      result.current.setNewProjectPath("D:\\AI\\ironcrew");
    });

    await act(async () => {
      await result.current.handlePickNativePath();
    });

    await waitFor(() => {
      expect(result.current.manualPathPickerOpen).toBe(true);
    });

    expect(result.current.nativePickerUnsupported).toBe(true);
    expect(result.current.nativePathPicking).toBe(false);
    expect(apiMocks.browseProjectPath).toHaveBeenCalledWith("D:\\AI\\ironcrew");
    expect(setFormFeedback).toHaveBeenCalledWith({
      tone: "info",
      message: "OS folder picker is unavailable in this environment. Use in-app browser or manual input.",
    });
  });
});
