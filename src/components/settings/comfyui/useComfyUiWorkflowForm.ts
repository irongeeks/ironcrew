import { useCallback, useEffect, useRef, useState } from "react";
import type { TFunction } from "../types";
import {
  listComfyUiWorkflows,
  createComfyUiWorkflow,
  updateComfyUiWorkflow,
  deleteComfyUiWorkflow,
  testComfyUiWorkflow,
  type ComfyUiWorkflow,
} from "../../../api/comfyui-workflows";
import { type FormState, EMPTY_FORM } from "./constants";
import { type ParsedNode, type RoleAssignment, parseWorkflowNodes, autoDetectRoles } from "./workflowNodeParser";

export function useComfyUiWorkflowForm() {
  const [workflows, setWorkflows] = useState<ComfyUiWorkflow[]>([]);
  const [loading, setLoading] = useState(true);
  const [addMode, setAddMode] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ id: string; ok: boolean; msg: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ComfyUI server URL (stored as setting)
  const [serverUrl, setServerUrl] = useState("");
  const [serverUrlSaved, setServerUrlSaved] = useState(false);

  // Node mapping state
  const [parsedNodes, setParsedNodes] = useState<ParsedNode[]>([]);
  const [roleAssignments, setRoleAssignments] = useState<RoleAssignment[]>([]);
  const [showRawJson, setShowRawJson] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Load server URL from settings
  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((data: { settings?: Record<string, unknown> }) => {
        const url = data.settings?.comfyui_server_url;
        if (typeof url === "string") setServerUrl(url);
      })
      .catch(() => {});
  }, []);

  const saveServerUrl = async (url: string) => {
    try {
      await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ comfyui_server_url: url }),
      });
      setServerUrlSaved(true);
      setTimeout(() => setServerUrlSaved(false), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const loadWorkflows = useCallback(async () => {
    setLoading(true);
    try {
      const list = await listComfyUiWorkflows();
      setWorkflows(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadWorkflows();
  }, [loadWorkflows]);

  const handleFileLoad = (jsonStr: string) => {
    try {
      JSON.parse(jsonStr);
    } catch {
      setError("Invalid JSON file");
      return;
    }
    setForm((f) => ({ ...f, workflow_json: jsonStr }));
    const nodes = parseWorkflowNodes(jsonStr);
    setParsedNodes(nodes);
    const detected = autoDetectRoles(nodes);
    setRoleAssignments(detected);
  };

  const handleFileDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (!file?.name.endsWith(".json")) {
      setError("Please drop a .json file");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => handleFileLoad(reader.result as string);
    reader.readAsText(file);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => handleFileLoad(reader.result as string);
    reader.readAsText(file);
    e.target.value = "";
  };

  const handleRoleChange = (roleKey: string, value: string) => {
    setRoleAssignments((prev) => {
      const filtered = prev.filter((a) => a.paramKey !== roleKey);
      if (!value) return filtered;
      const [nodeId, inputKey] = value.split("::");
      const node = parsedNodes.find((n) => n.nodeId === nodeId);
      return [...filtered, { paramKey: roleKey, nodeId, inputKey, description: node?.title || nodeId }];
    });
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      try {
        JSON.parse(form.workflow_json);
      } catch {
        setError("Workflow JSON must be valid JSON");
        setSaving(false);
        return;
      }

      const mappings = roleAssignments.map((a) => ({
        paramKey: a.paramKey,
        nodeId: a.nodeId,
        inputKey: a.inputKey,
        description: a.description,
      }));

      if (editingId) {
        await updateComfyUiWorkflow(editingId, {
          name: form.name,
          workflow_type: form.workflow_type,
          workflow_json: form.workflow_json,
          parameter_mappings: mappings,
          default_server_id: form.default_server_id || null,
        });
      } else {
        await createComfyUiWorkflow({
          name: form.name,
          workflow_type: form.workflow_type,
          workflow_json: form.workflow_json,
          parameter_mappings: mappings,
          default_server_id: form.default_server_id || undefined,
        });
      }

      setAddMode(false);
      setEditingId(null);
      setForm(EMPTY_FORM);
      setParsedNodes([]);
      setRoleAssignments([]);
      await loadWorkflows();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleEdit = (wf: ComfyUiWorkflow) => {
    setEditingId(wf.id);
    setAddMode(true);
    setForm({
      name: wf.name,
      workflow_type: wf.workflow_type,
      workflow_json: wf.workflow_json,
      parameter_mappings: wf.parameter_mappings_json,
      default_server_id: wf.default_server_id || "",
    });

    // Parse nodes and restore role assignments from existing mappings
    const nodes = parseWorkflowNodes(wf.workflow_json);
    setParsedNodes(nodes);
    try {
      const existing = JSON.parse(wf.parameter_mappings_json) as RoleAssignment[];
      setRoleAssignments(Array.isArray(existing) ? existing : []);
    } catch {
      setRoleAssignments([]);
    }
  };

  const handleDelete = async (id: string, t: TFunction) => {
    if (
      !window.confirm(
        t({
          ko: "이 워크플로우를 삭제하시겠습니까?",
          en: "Delete this workflow?",
          ja: "このワークフローを削除しますか？",
          zh: "Delete this workflow?",
          de: "Diesen Workflow löschen?",
        }),
      )
    )
      return;
    try {
      await deleteComfyUiWorkflow(id);
      await loadWorkflows();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleTest = async (id: string) => {
    setTesting(id);
    setTestResult(null);
    try {
      const result = await testComfyUiWorkflow(id);
      setTestResult({
        id,
        ok: result.ok,
        msg: result.ok ? "Test passed" : result.error || "Test failed",
      });
    } catch (e) {
      setTestResult({ id, ok: false, msg: e instanceof Error ? e.message : String(e) });
    } finally {
      setTesting(null);
    }
  };

  const resetForm = () => {
    setAddMode(false);
    setEditingId(null);
    setForm(EMPTY_FORM);
    setParsedNodes([]);
    setRoleAssignments([]);
    setError(null);
    setShowRawJson(false);
  };

  const startAdd = () => {
    setAddMode(true);
    setEditingId(null);
    setForm(EMPTY_FORM);
    setParsedNodes([]);
    setRoleAssignments([]);
  };

  return {
    // State
    workflows,
    loading,
    addMode,
    editingId,
    form,
    setForm,
    saving,
    testing,
    testResult,
    error,
    setError,
    serverUrl,
    setServerUrl,
    serverUrlSaved,
    parsedNodes,
    roleAssignments,
    showRawJson,
    setShowRawJson,
    dragOver,
    setDragOver,
    fileInputRef,

    // Handlers
    saveServerUrl,
    handleFileDrop,
    handleFileSelect,
    handleRoleChange,
    handleSave,
    handleEdit,
    handleDelete,
    handleTest,
    resetForm,
    startAdd,
  };
}
