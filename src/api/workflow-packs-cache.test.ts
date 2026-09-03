import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetApiRuntimeForTests } from "./core";
import {
  fetchEditorCapabilities,
  fetchEditorDepartments,
  fetchNodeTypes,
  invalidateEditorCaches,
} from "./workflow-packs";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("editor metadata cache", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    __resetApiRuntimeForTests();
    invalidateEditorCaches();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // ── fetchNodeTypes ──

  describe("fetchNodeTypes", () => {
    const mockNodeTypes = [
      {
        key: "echo",
        meta: { label: "Echo", description: "Pass-through", icon: "echo", color: "#ccc", category: "control" },
        configSchema: [],
        inputs: [],
        outputs: [],
      },
    ];

    it("returns cached data on second call without making a new fetch", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(mockNodeTypes));

      const first = await fetchNodeTypes();
      const second = await fetchNodeTypes();

      expect(first).toEqual(mockNodeTypes);
      expect(second).toEqual(mockNodeTypes);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("makes a new fetch after invalidateEditorCaches", async () => {
      const updatedNodeTypes = [...mockNodeTypes, { ...mockNodeTypes[0], key: "comfyui_generate" }];
      fetchMock
        .mockResolvedValueOnce(jsonResponse(mockNodeTypes))
        .mockResolvedValueOnce(jsonResponse(updatedNodeTypes));

      const first = await fetchNodeTypes();
      expect(first).toEqual(mockNodeTypes);

      invalidateEditorCaches();

      const second = await fetchNodeTypes();
      expect(second).toEqual(updatedNodeTypes);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("clears cache on fetch error so next call retries", async () => {
      fetchMock
        .mockRejectedValueOnce(new TypeError("Network error"))
        .mockResolvedValueOnce(jsonResponse(mockNodeTypes));

      const firstResult = await fetchNodeTypes();
      expect(firstResult).toEqual([]);

      const secondResult = await fetchNodeTypes();
      expect(secondResult).toEqual(mockNodeTypes);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  // ── fetchEditorCapabilities ──

  describe("fetchEditorCapabilities", () => {
    const mockCapabilities = [{ name: "text2img", connector: "comfyui" }];

    it("returns cached data on second call without making a new fetch", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ capabilities: mockCapabilities }));

      const first = await fetchEditorCapabilities();
      const second = await fetchEditorCapabilities();

      expect(first).toEqual(mockCapabilities);
      expect(second).toEqual(mockCapabilities);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("makes a new fetch after invalidateEditorCaches", async () => {
      const updatedCapabilities = [...mockCapabilities, { name: "web_search", connector: "web-search" }];
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ capabilities: mockCapabilities }))
        .mockResolvedValueOnce(jsonResponse({ capabilities: updatedCapabilities }));

      const first = await fetchEditorCapabilities();
      expect(first).toEqual(mockCapabilities);

      invalidateEditorCaches();

      const second = await fetchEditorCapabilities();
      expect(second).toEqual(updatedCapabilities);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("clears cache on fetch error so next call retries", async () => {
      fetchMock
        .mockRejectedValueOnce(new TypeError("Network error"))
        .mockResolvedValueOnce(jsonResponse({ capabilities: mockCapabilities }));

      const firstResult = await fetchEditorCapabilities();
      expect(firstResult).toEqual([]);

      const secondResult = await fetchEditorCapabilities();
      expect(secondResult).toEqual(mockCapabilities);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  // ── fetchEditorDepartments ──

  describe("fetchEditorDepartments", () => {
    const mockDepartments = [{ id: "planning", name: "Planning" }];

    it("returns cached data on second call without making a new fetch", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ departments: mockDepartments }));

      const first = await fetchEditorDepartments();
      const second = await fetchEditorDepartments();

      expect(first).toEqual(mockDepartments);
      expect(second).toEqual(mockDepartments);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("makes a new fetch after invalidateEditorCaches", async () => {
      const updatedDepartments = [...mockDepartments, { id: "design", name: "Design" }];
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ departments: mockDepartments }))
        .mockResolvedValueOnce(jsonResponse({ departments: updatedDepartments }));

      const first = await fetchEditorDepartments();
      expect(first).toEqual(mockDepartments);

      invalidateEditorCaches();

      const second = await fetchEditorDepartments();
      expect(second).toEqual(updatedDepartments);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("clears cache on fetch error so next call retries", async () => {
      fetchMock
        .mockRejectedValueOnce(new TypeError("Network error"))
        .mockResolvedValueOnce(jsonResponse({ departments: mockDepartments }));

      const firstResult = await fetchEditorDepartments();
      expect(firstResult).toEqual([]);

      const secondResult = await fetchEditorDepartments();
      expect(secondResult).toEqual(mockDepartments);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  // ── Cross-cache isolation ──

  describe("invalidateEditorCaches clears all three caches", () => {
    it("invalidates node types, capabilities, and departments together", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse([{ key: "echo" }]))
        .mockResolvedValueOnce(jsonResponse({ capabilities: [{ name: "text2img" }] }))
        .mockResolvedValueOnce(jsonResponse({ departments: [{ id: "dev" }] }));

      await fetchNodeTypes();
      await fetchEditorCapabilities();
      await fetchEditorDepartments();
      expect(fetchMock).toHaveBeenCalledTimes(3);

      invalidateEditorCaches();

      fetchMock
        .mockResolvedValueOnce(jsonResponse([{ key: "echo-v2" }]))
        .mockResolvedValueOnce(jsonResponse({ capabilities: [{ name: "web_search" }] }))
        .mockResolvedValueOnce(jsonResponse({ departments: [{ id: "design" }] }));

      const [types, caps, depts] = await Promise.all([
        fetchNodeTypes(),
        fetchEditorCapabilities(),
        fetchEditorDepartments(),
      ]);

      expect(types).toEqual([{ key: "echo-v2" }]);
      expect(caps).toEqual([{ name: "web_search" }]);
      expect(depts).toEqual([{ id: "design" }]);
      expect(fetchMock).toHaveBeenCalledTimes(6);
    });
  });
});
