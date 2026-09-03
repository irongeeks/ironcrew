import { describe, expect, it } from "vitest";
import type { Department } from "../types";
import {
  buildOfficePackPresentation,
  buildOfficePackStarterAgents,
  resolveOfficePackSeedProvider,
} from "./office-workflow-pack";

function makeDepartment(id: string): Department {
  return {
    id,
    name: id.toUpperCase(),
    name_ko: `${id}-ko`,
    name_ja: `${id}-ja`,
    name_zh: `${id}-zh`,
    icon: "🏢",
    color: "#64748b",
    description: null,
    prompt: null,
    sort_order: 1,
    created_at: 1,
  };
}

describe("buildOfficePackStarterAgents", () => {
  it("development 팩에서는 기본 직원을 생성하지 않는다", () => {
    const starters = buildOfficePackStarterAgents({
      packKey: "development",
      departments: [makeDepartment("planning"), makeDepartment("dev")],
    });
    expect(starters).toHaveLength(0);
  });

  it("비개발 팩에서는 기본 직원(팀장 포함)을 생성한다", () => {
    const starters = buildOfficePackStarterAgents({
      packKey: "web_research_report",
      departments: [makeDepartment("planning"), makeDepartment("dev"), makeDepartment("design"), makeDepartment("qa")],
      targetCount: 8,
    });

    expect(starters.length).toBeGreaterThanOrEqual(8);
    const leaderCount = starters.filter((agent) => agent.role === "team_leader").length;
    expect(leaderCount).toBeGreaterThanOrEqual(3);
    expect(starters.every((agent) => !!agent.department_id)).toBe(true);
  });

  it("비개발 팩 personality는 생성 시 locale 기준으로 작성된다", () => {
    const startersEn = buildOfficePackStarterAgents({
      packKey: "web_research_report",
      departments: [makeDepartment("planning"), makeDepartment("dev"), makeDepartment("design"), makeDepartment("qa")],
      targetCount: 4,
      locale: "en",
    });
    expect(startersEn.some((agent) => (agent.personality ?? "").includes("source credibility"))).toBe(true);

    const startersJa = buildOfficePackStarterAgents({
      packKey: "web_research_report",
      departments: [makeDepartment("planning"), makeDepartment("dev"), makeDepartment("design"), makeDepartment("qa")],
      targetCount: 4,
      locale: "ja",
    });
    expect(startersJa.some((agent) => (agent.personality ?? "").includes("信頼性"))).toBe(true);
  });

  it("starter 초안은 부서 내 순번(seed_order_in_department)을 기록한다", () => {
    const starters = buildOfficePackStarterAgents({
      packKey: "web_research_report",
      departments: [makeDepartment("planning"), makeDepartment("dev"), makeDepartment("design"), makeDepartment("qa")],
      targetCount: 8,
    });
    const planningOrders = starters
      .filter((agent) => agent.department_id === "planning")
      .map((agent) => agent.seed_order_in_department);
    expect(planningOrders.length).toBeGreaterThan(1);
    expect(planningOrders[0]).toBe(1);
    expect(planningOrders[1]).toBe(2);
  });

  it("오피스팩 seed 직원은 가능한 범위에서 sprite_number를 중복 없이 배정한다", () => {
    const starters = buildOfficePackStarterAgents({
      packKey: "video_preprod",
      departments: [makeDepartment("planning"), makeDepartment("dev"), makeDepartment("design"), makeDepartment("qa")],
      targetCount: 10,
    });
    const spriteNumbers = starters.map((agent) => agent.sprite_number);
    const unique = new Set(spriteNumbers);
    expect(unique.size).toBe(spriteNumbers.length);
  });
});

describe("resolveOfficePackSeedProvider", () => {
  it("기획팀은 claude/codex를 번갈아 배치한다", () => {
    expect(
      resolveOfficePackSeedProvider({
        packKey: "web_research_report",
        departmentId: "planning",
        role: "team_leader",
        seedIndex: 1,
        seedOrderInDepartment: 1,
      }),
    ).toBe("claude");
    expect(
      resolveOfficePackSeedProvider({
        packKey: "web_research_report",
        departmentId: "planning",
        role: "senior",
        seedIndex: 5,
        seedOrderInDepartment: 2,
      }),
    ).toBe("codex");
  });

  it("개발/디자인은 claude, QA는 codex를 사용한다", () => {
    expect(
      resolveOfficePackSeedProvider({
        packKey: "web_research_report",
        departmentId: "dev",
        role: "senior",
        seedIndex: 2,
      }),
    ).toBe("claude");
    expect(
      resolveOfficePackSeedProvider({
        packKey: "web_research_report",
        departmentId: "design",
        role: "senior",
        seedIndex: 3,
      }),
    ).toBe("claude");
    expect(
      resolveOfficePackSeedProvider({
        packKey: "web_research_report",
        departmentId: "qa",
        role: "senior",
        seedIndex: 6,
      }),
    ).toBe("codex");
  });

  it("design_studio 팩은 전문 디자인 조직용으로 claude를 고정 사용한다", () => {
    expect(
      resolveOfficePackSeedProvider({ packKey: "design_studio", departmentId: "design", role: "senior", seedIndex: 1 }),
    ).toBe("claude");
    expect(
      resolveOfficePackSeedProvider({
        packKey: "design_studio",
        departmentId: "qa",
        role: "team_leader",
        seedIndex: 2,
      }),
    ).toBe("claude");
  });
});

describe("buildOfficePackPresentation", () => {
  it("비개발 팩 부서 설명/프롬프트를 locale 기준으로 생성한다", () => {
    const presentationEn = buildOfficePackPresentation({
      packKey: "web_research_report",
      locale: "en",
      departments: [makeDepartment("planning")],
      agents: [],
      customRoomThemes: {},
    });
    expect(presentationEn.departments[0]?.description).toContain("team");
    expect(presentationEn.departments[0]?.prompt).toContain("[Department Role]");

    const presentationKo = buildOfficePackPresentation({
      packKey: "web_research_report",
      locale: "ko",
      departments: [makeDepartment("planning")],
      agents: [],
      customRoomThemes: {},
    });
    expect(presentationKo.departments[0]?.description).toContain("협업");
    expect(presentationKo.departments[0]?.prompt).toContain("[부서 역할]");
  });
});
