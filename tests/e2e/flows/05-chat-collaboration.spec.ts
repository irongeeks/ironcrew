import { test, expect } from "../fixtures/company-setup";

// TODO: Add UI interactions — currently API-only integration tests
test.describe("Chat Collaboration Flow", () => {
  test("send direct message and verify via API", async ({ request, csrfToken, teamLeader }) => {
    const msgRes = await request.post("/api/messages", {
      headers: { "x-csrf-token": csrfToken },
      data: {
        content: "E2E direct test message",
        receiver_type: "agent",
        receiver_id: teamLeader.id,
      },
    });
    expect(msgRes.ok()).toBeTruthy();

    // API returns { messages: [...] }
    const messagesRes = await request.get("/api/messages?limit=10");
    expect(messagesRes.ok()).toBeTruthy();
    const body = await messagesRes.json();
    const messages = body.messages ?? body;
    const found = (messages as { content: string }[]).find((m) => m.content?.includes("E2E direct test message"));
    expect(found).toBeTruthy();
  });

  test("send directive via API", async ({ request, csrfToken }) => {
    const directiveRes = await request.post("/api/directives", {
      headers: { "x-csrf-token": csrfToken },
      data: { content: "E2E directive test task" },
    });
    // Directive may create a task asynchronously — check response
    const status = directiveRes.status();
    expect(status).toBeLessThan(500); // Not a server error
  });
});
