import { useReducer, useCallback } from "react";
import type { PhaseDefinition, PackDefinitionResponse, PackInputField } from "../types";

export interface PackEditorState {
  packKey: string;
  source: "built-in" | "community";
  packMeta: {
    key: string;
    name: Record<string, string>;
    version: string;
    schema_version: number;
    description: Record<string, string>;
    icon?: string;
  };
  input: { required: PackInputField[]; optional: PackInputField[] };
  phases: PhaseDefinition[];
  costProfile?: Record<string, unknown>;
  qaRules?: Record<string, unknown>;
  staff?: Record<string, unknown>;
  ui?: Record<string, unknown>;
  selectedNodeId: string | null;
  dirty: boolean;
}

type Action =
  | { type: "LOAD_PACK"; pack: PackDefinitionResponse }
  | { type: "SELECT_NODE"; nodeId: string | null }
  | { type: "ADD_PHASE"; phase: PhaseDefinition }
  | { type: "REMOVE_PHASE"; phaseId: string }
  | { type: "UPDATE_PHASE"; phaseId: string; updates: Partial<PhaseDefinition> }
  | { type: "CONNECT_PORTS"; targetPhaseId: string; inputName: string; from: string }
  | { type: "DISCONNECT_PORTS"; targetPhaseId: string; inputName: string }
  | { type: "ADD_OUTPUT"; phaseId: string; output: PhaseDefinition["outputs"][0] }
  | { type: "REMOVE_OUTPUT"; phaseId: string; outputName: string }
  | { type: "SET_DIRTY"; dirty: boolean }
  | { type: "UPDATE_PACK_META"; updates: Partial<Pick<PackEditorState, "packMeta" | "costProfile" | "qaRules">> }
  | { type: "UPDATE_INPUT"; input: { required: PackInputField[]; optional: PackInputField[] } };

function reducer(state: PackEditorState, action: Action): PackEditorState {
  switch (action.type) {
    case "LOAD_PACK": {
      const { pack } = action;
      return {
        packKey: pack.key,
        source: pack.source,
        packMeta: pack.definition.pack,
        input: pack.definition.input ?? { required: [], optional: [] },
        phases: pack.definition.phases,
        costProfile: pack.definition.cost_profile as Record<string, unknown> | undefined,
        qaRules: pack.definition.qa_rules as Record<string, unknown> | undefined,
        staff: pack.definition.staff as Record<string, unknown> | undefined,
        ui: pack.definition.ui as Record<string, unknown> | undefined,
        selectedNodeId: null,
        dirty: false,
      };
    }

    case "SELECT_NODE":
      return { ...state, selectedNodeId: action.nodeId };

    case "ADD_PHASE":
      return {
        ...state,
        phases: [...state.phases, action.phase],
        dirty: true,
      };

    case "REMOVE_PHASE": {
      // Remove phase and any input references to it
      const removed = action.phaseId;
      return {
        ...state,
        phases: state.phases
          .filter((p) => p.id !== removed)
          .map((p) => ({
            ...p,
            inputs: p.inputs.filter((inp) => !inp.from.startsWith(removed + ".")),
          })),
        selectedNodeId: state.selectedNodeId === removed ? null : state.selectedNodeId,
        dirty: true,
      };
    }

    case "UPDATE_PHASE":
      return {
        ...state,
        phases: state.phases.map((p) => (p.id === action.phaseId ? { ...p, ...action.updates } : p)),
        dirty: true,
      };

    case "CONNECT_PORTS":
      return {
        ...state,
        phases: state.phases.map((p) => {
          if (p.id !== action.targetPhaseId) return p;
          // Avoid duplicate connections
          if (p.inputs.some((i) => i.name === action.inputName)) return p;
          return { ...p, inputs: [...p.inputs, { name: action.inputName, from: action.from }] };
        }),
        dirty: true,
      };

    case "DISCONNECT_PORTS":
      return {
        ...state,
        phases: state.phases.map((p) => {
          if (p.id !== action.targetPhaseId) return p;
          return { ...p, inputs: p.inputs.filter((i) => i.name !== action.inputName) };
        }),
        dirty: true,
      };

    case "ADD_OUTPUT":
      return {
        ...state,
        phases: state.phases.map((p) => {
          if (p.id !== action.phaseId) return p;
          return { ...p, outputs: [...p.outputs, action.output] };
        }),
        dirty: true,
      };

    case "REMOVE_OUTPUT": {
      const ref = `${action.phaseId}.${action.outputName}`;
      return {
        ...state,
        phases: state.phases.map((p) => {
          if (p.id === action.phaseId) {
            return { ...p, outputs: p.outputs.filter((o) => o.name !== action.outputName) };
          }
          // Remove any input references to this output
          return { ...p, inputs: p.inputs.filter((i) => i.from !== ref) };
        }),
        dirty: true,
      };
    }

    case "UPDATE_PACK_META":
      return {
        ...state,
        ...(action.updates.packMeta ? { packMeta: action.updates.packMeta } : {}),
        ...(action.updates.costProfile !== undefined ? { costProfile: action.updates.costProfile } : {}),
        ...(action.updates.qaRules !== undefined ? { qaRules: action.updates.qaRules } : {}),
        dirty: true,
      };

    case "UPDATE_INPUT":
      return { ...state, input: action.input, dirty: true };

    case "SET_DIRTY":
      return { ...state, dirty: action.dirty };

    default:
      action satisfies never;
      return state;
  }
}

const MAX_HISTORY = 50;

interface HistoryState {
  current: PackEditorState;
  past: PackEditorState[];
  future: PackEditorState[];
}

type HistoryAction = { type: "UNDO" } | { type: "REDO" } | { type: "PUSH"; action: Action };

function historyReducer(state: HistoryState, historyAction: HistoryAction): HistoryState {
  switch (historyAction.type) {
    case "UNDO": {
      if (state.past.length === 0) return state;
      const previous = state.past[state.past.length - 1];
      return {
        current: previous,
        past: state.past.slice(0, -1),
        future: [state.current, ...state.future],
      };
    }
    case "REDO": {
      if (state.future.length === 0) return state;
      const next = state.future[0];
      return {
        current: next,
        past: [...state.past, state.current],
        future: state.future.slice(1),
      };
    }
    case "PUSH": {
      const next = reducer(state.current, historyAction.action);
      if (next === state.current) return state;
      if (historyAction.action.type === "LOAD_PACK") {
        return { current: next, past: [], future: [] };
      }
      const isNonHistoric = historyAction.action.type === "SELECT_NODE" || historyAction.action.type === "SET_DIRTY";
      if (isNonHistoric) {
        return { ...state, current: next };
      }
      return {
        current: next,
        past: [...state.past.slice(-MAX_HISTORY), state.current],
        future: [],
      };
    }
  }
}

const INITIAL_STATE: PackEditorState = {
  packKey: "",
  source: "community",
  packMeta: { key: "", name: { en: "" }, version: "1.0.0", schema_version: 1, description: { en: "" } },
  input: { required: [], optional: [] },
  phases: [],
  selectedNodeId: null,
  dirty: false,
};

export function usePackEditorState() {
  const [historyState, historyDispatch] = useReducer(historyReducer, {
    current: INITIAL_STATE,
    past: [],
    future: [],
  });

  const state = historyState.current;

  const dispatch = useCallback((action: Action) => historyDispatch({ type: "PUSH", action }), []);

  const undo = useCallback(() => historyDispatch({ type: "UNDO" }), []);
  const redo = useCallback(() => historyDispatch({ type: "REDO" }), []);

  const loadPack = useCallback(
    (pack: PackDefinitionResponse) => {
      dispatch({ type: "LOAD_PACK", pack });
    },
    [dispatch],
  );

  const selectNode = useCallback(
    (nodeId: string | null) => {
      dispatch({ type: "SELECT_NODE", nodeId });
    },
    [dispatch],
  );

  const addPhase = useCallback(
    (phase: PhaseDefinition) => {
      dispatch({ type: "ADD_PHASE", phase });
    },
    [dispatch],
  );

  const removePhase = useCallback(
    (phaseId: string) => {
      dispatch({ type: "REMOVE_PHASE", phaseId });
    },
    [dispatch],
  );

  const updatePhase = useCallback(
    (phaseId: string, updates: Partial<PhaseDefinition>) => {
      dispatch({ type: "UPDATE_PHASE", phaseId, updates });
    },
    [dispatch],
  );

  const connectPorts = useCallback(
    (targetPhaseId: string, inputName: string, from: string) => {
      dispatch({ type: "CONNECT_PORTS", targetPhaseId, inputName, from });
    },
    [dispatch],
  );

  const disconnectPorts = useCallback(
    (targetPhaseId: string, inputName: string) => {
      dispatch({ type: "DISCONNECT_PORTS", targetPhaseId, inputName });
    },
    [dispatch],
  );

  const updatePackMeta = useCallback(
    (updates: Partial<Pick<PackEditorState, "packMeta" | "costProfile" | "qaRules">>) => {
      dispatch({ type: "UPDATE_PACK_META", updates });
    },
    [dispatch],
  );

  const updateInput = useCallback(
    (input: { required: PackInputField[]; optional: PackInputField[] }) => {
      dispatch({ type: "UPDATE_INPUT", input });
    },
    [dispatch],
  );

  const setDirty = useCallback(
    (dirty: boolean) => {
      dispatch({ type: "SET_DIRTY", dirty });
    },
    [dispatch],
  );

  return {
    state,
    dispatch,
    loadPack,
    selectNode,
    addPhase,
    removePhase,
    updatePhase,
    connectPorts,
    disconnectPorts,
    updatePackMeta,
    updateInput,
    setDirty,
    undo,
    redo,
    canUndo: historyState.past.length > 0,
    canRedo: historyState.future.length > 0,
  };
}
