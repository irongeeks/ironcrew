import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { usePackEditorState } from "../hooks/usePackEditorState";
import type { PackDefinitionResponse } from "../types";

const MOCK_PACK: PackDefinitionResponse = {
  key: "test_pack",
  source: "community",
  definition: {
    pack: { key: "test_pack", name: { en: "Test" }, version: "1.0.0", schema_version: 1, description: { en: "" } },
    input: { required: [], optional: [] },
    phases: [
      {
        id: "phase_a",
        department: "dev",
        guidance: "guidance/phase_a.{lang}.md",
        inputs: [],
        outputs: [{ name: "result", type: "markdown", path: "out/result.md" }],
      },
    ],
  },
  guidanceLanguages: {},
};

describe("usePackEditorState undo/redo", () => {
  it("can undo a phase addition", () => {
    const { result } = renderHook(() => usePackEditorState());
    act(() => result.current.loadPack(MOCK_PACK));
    expect(result.current.state.phases).toHaveLength(1);

    act(() =>
      result.current.addPhase({
        id: "new_phase",
        department: "dev",
        guidance: "guidance/new_phase.{lang}.md",
        inputs: [],
        outputs: [],
      }),
    );
    expect(result.current.state.phases).toHaveLength(2);

    act(() => result.current.undo());
    expect(result.current.state.phases).toHaveLength(1);
  });

  it("can redo after undo", () => {
    const { result } = renderHook(() => usePackEditorState());
    act(() => result.current.loadPack(MOCK_PACK));
    act(() =>
      result.current.addPhase({
        id: "new_phase",
        department: "dev",
        guidance: "guidance/new_phase.{lang}.md",
        inputs: [],
        outputs: [],
      }),
    );
    act(() => result.current.undo());
    expect(result.current.state.phases).toHaveLength(1);

    act(() => result.current.redo());
    expect(result.current.state.phases).toHaveLength(2);
  });

  it("redo stack clears on new action after undo", () => {
    const { result } = renderHook(() => usePackEditorState());
    act(() => result.current.loadPack(MOCK_PACK));
    act(() =>
      result.current.addPhase({
        id: "phase_b",
        department: "dev",
        guidance: "guidance/phase_b.{lang}.md",
        inputs: [],
        outputs: [],
      }),
    );
    act(() => result.current.undo());

    act(() =>
      result.current.addPhase({
        id: "phase_c",
        department: "qa",
        guidance: "guidance/phase_c.{lang}.md",
        inputs: [],
        outputs: [],
      }),
    );
    act(() => result.current.redo());
    expect(result.current.state.phases).toHaveLength(2);
    expect(result.current.state.phases[1].id).toBe("phase_c");
  });

  it("canUndo and canRedo reflect state", () => {
    const { result } = renderHook(() => usePackEditorState());
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);

    act(() => result.current.loadPack(MOCK_PACK));
    expect(result.current.canUndo).toBe(false);

    act(() =>
      result.current.addPhase({
        id: "x",
        department: "dev",
        guidance: "guidance/x.{lang}.md",
        inputs: [],
        outputs: [],
      }),
    );
    expect(result.current.canUndo).toBe(true);
    expect(result.current.canRedo).toBe(false);

    act(() => result.current.undo());
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(true);
  });
});
