import { expect, test, type APIRequestContext, type APIResponse } from "@playwright/test";
import path from "node:path";

type DepartmentResponse = {
  department: {
    id: string;
  };
  agents?: Array<{ id: string }>;
};

type AgentCreateResponse = {
  ok: boolean;
  agent: {
    id: string;
    department_id: string | null;
    role: string;
  };
};

type ProjectCreateResponse = {
  ok: boolean;
  project: {
    id: string;
    assignment_mode: string;
    assigned_agent_ids: string[];
  };
};

type TaskRow = {
  id: string;
  title: string;
  project_id: string | null;
  department_id?: string | null;
  assigned_agent_id: string | null;
  status: string;
};

type TasksResponse = {
  tasks: TaskRow[];
};

type TaskDetailResponse = {
  task: {
    id: string;
  };
  logs: Array<{
    message: string;
  }>;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function expectOkJson<T>(response: APIResponse, label: string): Promise<T> {
  const text = await response.text();
  let parsed: unknown = {};
  if (text.trim()) {
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`${label}: JSON 파싱 실패 (status=${response.status()}): ${text.slice(0, 500)}`);
    }
  }
  if (!response.ok()) {
    throw new Error(`${label}: 요청 실패 (status=${response.status()}): ${text.slice(0, 1000)}`);
  }
  return parsed as T;
}

async function establishApiSession(request: APIRequestContext): Promise<string> {
  const timeoutMs = 30_000;
  const startedAt = Date.now();
  let lastStatus = 0;
  let lastText = "";

  while (Date.now() - startedAt < timeoutMs) {
    const response = await request.get("/api/auth/session");
    const text = await response.text();
    if (response.ok()) {
      const body = JSON.parse(text);
      return body.csrf_token as string;
    }
    lastStatus = response.status();
    lastText = text;
    if (lastStatus === 502 || lastStatus === 503 || lastStatus === 404) {
      await sleep(500);
      continue;
    }
    throw new Error(`GET /api/auth/session 실패 (status=${lastStatus}): ${lastText.slice(0, 1000)}`);
  }

  throw new Error(`GET /api/auth/session 타임아웃 (status=${lastStatus}): ${lastText.slice(0, 1000)}`);
}

async function fetchProjectTasks(request: APIRequestContext, projectId: string): Promise<TaskRow[]> {
  const timeoutMs = 8_000;
  const startedAt = Date.now();
  let lastStatus = 0;
  let lastText = "";

  while (Date.now() - startedAt < timeoutMs) {
    const response = await request.get(`/api/tasks?project_id=${encodeURIComponent(projectId)}`);
    if (response.ok()) {
      const json = await expectOkJson<TasksResponse>(response, `GET /api/tasks?project_id=${projectId}`);
      return Array.isArray(json.tasks) ? json.tasks : [];
    }

    lastStatus = response.status();
    lastText = await response.text();
    if (lastStatus === 502 || lastStatus === 503 || lastStatus === 404) {
      await sleep(250);
      continue;
    }
    throw new Error(`GET /api/tasks?project_id=${projectId} 실패 (status=${lastStatus}): ${lastText.slice(0, 1000)}`);
  }

  throw new Error(`GET /api/tasks?project_id=${projectId} 타임아웃 (status=${lastStatus}): ${lastText.slice(0, 1000)}`);
}

async function waitForTaskAssignment(
  request: APIRequestContext,
  projectId: string,
  title: string,
  assignedAgentId: string,
  departmentId: string,
  timeoutMs: number,
): Promise<TaskRow> {
  const startedAt = Date.now();
  let lastTasks: TaskRow[] = [];
  while (Date.now() - startedAt < timeoutMs) {
    const tasks = await fetchProjectTasks(request, projectId);
    lastTasks = tasks;
    const matched = tasks.find((task) => task.title === title && task.department_id === departmentId);
    if (matched?.assigned_agent_id === assignedAgentId) {
      return matched;
    }
    await sleep(400);
  }
  const debugSummary = lastTasks.map((task) => `${task.title}:${task.assigned_agent_id ?? "null"}`).join(" | ");
  throw new Error(
    `작업 배정 대기 시간 초과 (project=${projectId}, expectedAgent=${assignedAgentId}, department=${departmentId}, title=${title}, tasks=${debugSummary})`,
  );
}

test.describe("CI manual assignment coverage", () => {
  test.setTimeout(150_000);

  test("신규 부서/팀원 추가 + 수동 배정(선택 팀원/팀장 fallback) 실행 검증", async ({ request }) => {
    const seed = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const deptId = `ci_dept_${seed}`;

    const leaderName = `ci-leader-${seed}`;
    const memberName = `ci-member-${seed}`;
    const subProjectPath = path.resolve("test-results", "ci-e2e", seed, "subordinate");
    const leaderProjectPath = path.resolve("test-results", "ci-e2e", seed, "leader");

    const csrfToken = await establishApiSession(request);
    const csrfHeaders = { "x-csrf-token": csrfToken };

    const createDeptRes = await request.post("/api/departments", {
      headers: csrfHeaders,
      data: {
        id: deptId,
        name: `CI Department ${seed}`,
        name_ko: `CI부서-${seed}`,
        icon: "🧪",
        color: "#16a34a",
        description: "CI scenario department",
      },
    });
    const createDept = await expectOkJson<DepartmentResponse>(createDeptRes, "POST /api/departments");
    expect(createDept.department.id).toBe(deptId);

    const createLeaderRes = await request.post("/api/agents", {
      headers: csrfHeaders,
      data: {
        name: leaderName,
        name_ko: `팀장-${seed}`,
        department_id: deptId,
        role: "team_leader",
        cli_provider: "api",
        avatar_emoji: "🧪",
      },
    });
    const createLeader = await expectOkJson<AgentCreateResponse>(createLeaderRes, "POST /api/agents(team_leader)");
    expect(createLeader.ok).toBe(true);
    expect(createLeader.agent.department_id).toBe(deptId);
    expect(createLeader.agent.role).toBe("team_leader");
    const leaderId = createLeader.agent.id;

    const createMemberRes = await request.post("/api/agents", {
      headers: csrfHeaders,
      data: {
        name: memberName,
        name_ko: `팀원-${seed}`,
        department_id: deptId,
        role: "senior",
        cli_provider: "api",
        avatar_emoji: "🧪",
      },
    });
    const createMember = await expectOkJson<AgentCreateResponse>(createMemberRes, "POST /api/agents(member)");
    expect(createMember.ok).toBe(true);
    expect(createMember.agent.department_id).toBe(deptId);
    const memberId = createMember.agent.id;

    const deptDetailRes = await request.get(`/api/departments/${deptId}`);
    const deptDetail = await expectOkJson<DepartmentResponse>(deptDetailRes, "GET /api/departments/:id");
    const deptAgentIds = new Set((deptDetail.agents ?? []).map((agent) => agent.id));
    expect(deptAgentIds.has(leaderId)).toBe(true);
    expect(deptAgentIds.has(memberId)).toBe(true);

    const createSubProjectRes = await request.post("/api/projects", {
      headers: { "x-csrf-token": csrfToken },
      data: {
        name: `ci-project-sub-${seed}`,
        project_path: subProjectPath,
        core_goal: "CI subordinate delegation path",
        assignment_mode: "manual",
        agent_ids: [memberId],
      },
    });
    const subProject = await expectOkJson<ProjectCreateResponse>(
      createSubProjectRes,
      "POST /api/projects(subordinate)",
    );
    expect(subProject.ok).toBe(true);
    expect(subProject.project.assignment_mode).toBe("manual");
    expect(subProject.project.assigned_agent_ids).toEqual([memberId]);
    const subProjectId = subProject.project.id;

    const subordinateTaskTitle = `ci-sub-${seed} @${deptId} 작업`;
    const subordinateDirectiveRes = await request.post("/api/directives", {
      headers: csrfHeaders,
      data: {
        content: subordinateTaskTitle,
        skipPlannedMeeting: true,
        project_id: subProjectId,
      },
    });
    await expectOkJson(subordinateDirectiveRes, "POST /api/directives(subordinate delegation)");

    const subordinateTask = await waitForTaskAssignment(
      request,
      subProjectId,
      subordinateTaskTitle,
      memberId,
      deptId,
      45_000,
    );
    expect(subordinateTask.project_id).toBe(subProjectId);
    expect(subordinateTask.assigned_agent_id).toBe(memberId);
    expect(subordinateTask.department_id).toBe(deptId);

    const createLeaderProjectRes = await request.post("/api/projects", {
      headers: { "x-csrf-token": csrfToken },
      data: {
        name: `ci-project-leader-${seed}`,
        project_path: leaderProjectPath,
        core_goal: "CI leader fallback path",
        assignment_mode: "manual",
        agent_ids: [leaderId],
      },
    });
    const leaderProject = await expectOkJson<ProjectCreateResponse>(
      createLeaderProjectRes,
      "POST /api/projects(leader-only)",
    );
    expect(leaderProject.ok).toBe(true);
    expect(leaderProject.project.assignment_mode).toBe("manual");
    expect(leaderProject.project.assigned_agent_ids).toEqual([leaderId]);
    const leaderProjectId = leaderProject.project.id;

    const leaderTaskTitle = `ci-leader-${seed} @${deptId} 작업`;
    const leaderDirectiveRes = await request.post("/api/directives", {
      headers: csrfHeaders,
      data: {
        content: leaderTaskTitle,
        skipPlannedMeeting: true,
        project_id: leaderProjectId,
      },
    });
    await expectOkJson(leaderDirectiveRes, "POST /api/directives(leader fallback)");

    const leaderTask = await waitForTaskAssignment(request, leaderProjectId, leaderTaskTitle, leaderId, deptId, 45_000);
    expect(leaderTask.project_id).toBe(leaderProjectId);
    expect(leaderTask.assigned_agent_id).toBe(leaderId);
    expect(leaderTask.department_id).toBe(deptId);

    const leaderTaskDetailRes = await request.get(`/api/tasks/${leaderTask.id}`);
    const leaderTaskDetail = await expectOkJson<TaskDetailResponse>(leaderTaskDetailRes, "GET /api/tasks/:id");
    const hasFallbackLog = leaderTaskDetail.logs.some((log) => log.message.includes("Manual assignment fallback"));
    expect(hasFallbackLog).toBe(true);
  });
});
