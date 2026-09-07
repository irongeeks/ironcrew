import { it, expect } from "vitest";
import {
  googleConfigurationSha256,
  googleWorkspaceCapabilities,
} from "../../packages/integrations/src/google-workspace.ts";
import { sha256 } from "../../packages/domain/src/index.ts";
import { googleWorkspaceFixture as fixture } from "../fixtures/google-workspace.ts";
it("creates a native Google Doc in the exact folder and sends revision-controlled targeted document edits", async () => {
  const f = await fixture();
  try {
    expect(googleConfigurationSha256(f.connection)).toBe(sha256(f.connection));
    const created = await f.call("gdocs.create", {
      folderId: "folder-a",
      title: "Sourced report",
      text: "Original research text",
    });
    expect(created.externalId).toBe("created-doc");
    expect(f.seen[0]!.body).toContain('"mimeType":"application/vnd.google-apps.document"');
    expect(f.seen[0]!.body).toContain('"parents":["folder-a"]');
    expect(f.seen[0]!.body).toContain("Original research text");
    const read = await f.call("gdocs.read", { documentId: "doc-a" });
    expect(read.data).toMatchObject({ revisionId: "r1" });
    await f.call("gdocs.append", { documentId: "doc-a", tabId: "tab-a", requiredRevisionId: "r1", text: " checked" });
    expect(f.state.docText).toBe("before checked");
    expect(JSON.parse(f.seen.at(-1)!.body)).toEqual({
      writeControl: { requiredRevisionId: "r1" },
      requests: [{ insertText: { endOfSegmentLocation: { tabId: "tab-a" }, text: " checked" } }],
    });
    await expect(
      f.call("gdocs.append", { documentId: "doc-a", tabId: "tab-a", requiredRevisionId: "r1", text: " stale" }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(f.state.docText).toBe("before checked");
    await f.call("gdocs.replace", {
      documentId: "doc-a",
      tabId: "tab-a",
      requiredRevisionId: "r2",
      startIndex: 1,
      endIndex: 4,
      text: "new",
    });
    expect(JSON.parse(f.seen.at(-1)!.body).requests).toEqual([
      { deleteContentRange: { range: { tabId: "tab-a", startIndex: 1, endIndex: 4 } } },
      { insertText: { location: { tabId: "tab-a", index: 1 }, text: "new" } },
    ]);
    expect(f.seen.every((r) => r.authorization === "Bearer fixture-access-token")).toBe(true);
  } finally {
    await f.close();
  }
});
it("copies only an approved Sheets rectangle into a new native version, with typed literal cells and no unsafe source overwrite", async () => {
  const f = await fixture();
  try {
    const rectangle = {
      spreadsheetId: "sheet-a",
      sheetTitle: "Data",
      startRow: 1,
      rowCount: 1,
      startColumn: 1,
      columnCount: 2,
    };
    const read = await f.call("gsheets.read", rectangle),
      before = read.data as { contentSha256: string };
    const args = {
      ...rectangle,
      expectedContentSha256: before.contentSha256,
      title: "Version2",
      newSheetTitle: "Data copy",
      edits: [{ row: 0, column: 0, value: '=IMPORTXML("https://invalid", "x")' }],
    };
    const created = await f.call("gsheets.version.create", args);
    expect(created.data).toMatchObject({ sourceUnchanged: true, representation: "new_rectangle_snapshot" });
    expect(f.state.values).toEqual([["label", 17]]);
    expect(JSON.stringify(f.state.createdSheets[0])).toContain("stringValue");
    expect(JSON.stringify(f.state.createdSheets[0])).not.toContain("formulaValue");
    f.state.values = [["changed", 17]];
    await expect(f.call("gsheets.version.create", args)).rejects.toMatchObject({ code: "conflict" });
    expect(f.state.createdSheets).toHaveLength(1);
    await f.call("gsheets.create", { title: "New table", sheetTitle: "Rows", rows: [["name", true, 3, null]] });
    expect(f.state.createdSheets).toHaveLength(2);
  } finally {
    await f.close();
  }
});
it("supports scoped Slides creation/read and revision-controlled object text replacement", async () => {
  const f = await fixture();
  try {
    expect((await f.call("gslides.create", { title: "Fixture deck" })).externalId).toBe("created-slides");
    expect((await f.call("gslides.read", { presentationId: "pres-a" })).data).toMatchObject({ revisionId: "s1" });
    await f.call("gslides.text.replace", {
      presentationId: "pres-a",
      requiredRevisionId: "s1",
      objectId: "text-a",
      text: "Updated",
    });
    expect(f.state.slideText).toBe("Updated");
    expect(JSON.parse(f.seen.at(-1)!.body)).toEqual({
      writeControl: { requiredRevisionId: "s1" },
      requests: [
        { deleteText: { objectId: "text-a", textRange: { type: "ALL" } } },
        { insertText: { objectId: "text-a", insertionIndex: 0, text: "Updated" } },
      ],
    });
  } finally {
    await f.close();
  }
});
it("denies foreign resources, changed configuration and arbitrary batches; unconfirmed creation is never automatically retried", async () => {
  const f = await fixture();
  try {
    await expect(f.call("gdocs.read", { documentId: "foreign" })).rejects.toMatchObject({ code: "authorization" });
    await expect(
      f.call("gdocs.create", { folderId: "folder-a", title: "x", text: "x", targetConfigSha256: "a".repeat(64) }),
    ).rejects.toMatchObject({ code: "authorization" });
    await expect(
      f.call("gdocs.append", {
        documentId: "doc-a",
        tabId: "tab-a",
        requiredRevisionId: "r1",
        text: "x",
        requests: [{ deleteDocument: {} }],
      }),
    ).rejects.toMatchObject({ code: "validation" });
    expect(f.seen).toHaveLength(0);
    f.state.failCreate = true;
    await expect(
      f.call("gsheets.create", { title: "New table", sheetTitle: "Rows", rows: [["x"]] }),
    ).rejects.toMatchObject({ effectStatus: "effect_unknown" });
    expect(f.state.createdSheets).toHaveLength(1);
    expect(googleWorkspaceCapabilities.filter((c) => c.effect !== "read").every((c) => c.requiresApproval)).toBe(true);
  } finally {
    await f.close();
  }
});
