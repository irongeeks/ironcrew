import { describe, expect, it } from "vitest";
import { buildMessengerTokenKey } from "./token-hint.ts";
import {
  resolveAgentSessionRoutesFromSettings,
  resolveSessionAgentRouteFromSettings,
  resolveSessionTargetRouteFromSettings,
  resolveSourceChatRoute,
} from "./session-agent-routing.ts";

describe("session-agent-routing", () => {
  it("텔레그램 세션 targetId와 chat이 일치하면 agentId를 반환한다", () => {
    const route = resolveSessionAgentRouteFromSettings({
      settingsValue: {
        telegram: {
          sessions: [{ id: "tg-ops", name: "Ops", targetId: "7028830484", enabled: true, agentId: "a-1" }],
        },
      },
      source: "telegram",
      chat: "telegram:7028830484",
    });

    expect(route).toEqual({
      channel: "telegram",
      sessionId: "tg-ops",
      sessionName: "Ops",
      targetId: "7028830484",
      agentId: "a-1",
    });
  });

  it("agentId가 없으면 매핑하지 않는다", () => {
    const route = resolveSessionAgentRouteFromSettings({
      settingsValue: {
        telegram: {
          sessions: [{ id: "tg-ops", name: "Ops", targetId: "7028830484", enabled: true }],
        },
      },
      source: "telegram",
      chat: "7028830484",
    });

    expect(route).toBeNull();
  });

  it("agentId가 없어도 세션 타깃 라우트는 해석할 수 있다", () => {
    const route = resolveSessionTargetRouteFromSettings({
      settingsValue: {
        telegram: {
          sessions: [{ id: "tg-ops", name: "Ops", targetId: "7028830484", enabled: true }],
        },
      },
      source: "telegram",
      chat: "telegram:7028830484",
    });

    expect(route).toEqual({
      channel: "telegram",
      sessionId: "tg-ops",
      sessionName: "Ops",
      targetId: "7028830484",
    });
  });

  it("source 토큰 힌트가 있으면 동일 chat_id에서도 일치하는 토큰 세션을 우선 매핑한다", () => {
    const tokenA = "tg-token-a";
    const tokenB = "tg-token-b";
    const tokenBKey = buildMessengerTokenKey("telegram", tokenB);
    const route = resolveSessionTargetRouteFromSettings({
      settingsValue: {
        telegram: {
          token: tokenA,
          sessions: [
            { id: "tg-a", name: "A", targetId: "7028830484", enabled: true },
            { id: "tg-b", name: "B", targetId: "7028830484", enabled: true, token: tokenB },
          ],
        },
      },
      source: `telegram#${tokenBKey}`,
      chat: "telegram:7028830484",
    });

    expect(route).toEqual({
      channel: "telegram",
      sessionId: "tg-b",
      sessionName: "B",
      targetId: "7028830484",
    });
  });

  it("session.id가 비어 있어도 동일 chat_id 다중 세션을 인덱스 기반으로 구분한다", () => {
    const tokenA = "tg-token-a";
    const tokenB = "tg-token-b";
    const tokenBKey = buildMessengerTokenKey("telegram", tokenB);
    const route = resolveSessionTargetRouteFromSettings({
      settingsValue: {
        telegram: {
          token: tokenA,
          sessions: [
            { name: "A", targetId: "7028830484", enabled: true },
            { name: "B", targetId: "7028830484", enabled: true, token: tokenB },
          ],
        },
      },
      source: `telegram#${tokenBKey}`,
      chat: "telegram:7028830484",
    });

    expect(route).toEqual({
      channel: "telegram",
      sessionId: "telegram-2",
      sessionName: "B",
      targetId: "7028830484",
    });
  });

  it("비활성 세션은 매핑하지 않는다", () => {
    const route = resolveSessionAgentRouteFromSettings({
      settingsValue: {
        discord: {
          sessions: [
            { id: "dc-1", name: "Discord", targetId: "channel:1469158639695695904", enabled: false, agentId: "a-2" },
          ],
        },
      },
      source: "discord",
      chat: "channel:1469158639695695904",
    });

    expect(route).toBeNull();
  });

  it("agentId로 매핑된 활성 세션 목록을 채널별로 역조회한다", () => {
    const routes = resolveAgentSessionRoutesFromSettings({
      settingsValue: {
        telegram: {
          sessions: [
            { id: "tg-1", name: "TG Ops", targetId: "7028830484", enabled: true, agentId: "a-1" },
            { id: "tg-2", name: "TG Off", targetId: "7028830485", enabled: false, agentId: "a-1" },
          ],
        },
        discord: {
          sessions: [
            { id: "dc-1", name: "DC Ops", targetId: "channel:1469158639695695904", enabled: true, agentId: "a-1" },
          ],
        },
        slack: {
          sessions: [{ id: "sl-1", name: "SL Ops", targetId: "channel:C12345", enabled: true, agentId: "a-2" }],
        },
      },
      agentId: "a-1",
    });

    expect(routes).toEqual([
      {
        channel: "telegram",
        sessionId: "tg-1",
        sessionName: "TG Ops",
        targetId: "7028830484",
      },
      {
        channel: "discord",
        sessionId: "dc-1",
        sessionName: "DC Ops",
        targetId: "1469158639695695904",
      },
    ]);
  });

  it("source/chat 만으로 기본 라우트를 해석한다", () => {
    expect(resolveSourceChatRoute({ source: "google_chat", chat: "space:spaces/AAAABBBB" })).toEqual({
      channel: "googlechat",
      targetId: "spaces/AAAABBBB",
    });
    expect(resolveSourceChatRoute({ source: "telegram", chat: "telegram:7028830484" })).toEqual({
      channel: "telegram",
      targetId: "7028830484",
    });
  });
});
