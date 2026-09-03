import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import SkillHistoryPanel from "./SkillHistoryPanel";
import type { Agent } from "../types";
import { getAvailableLearnedSkills, getSkillLearningHistory, unlearnSkill } from "../api";

vi.mock("../api", () => ({
  getSkillLearningHistory: vi.fn().mockResolvedValue({
    history: [],
    retentionDays: 180,
  }),
  getAvailableLearnedSkills: vi.fn().mockResolvedValue([]),
  unlearnSkill: vi.fn(),
}));

const getSkillLearningHistoryMock = vi.mocked(getSkillLearningHistory);
const getAvailableLearnedSkillsMock = vi.mocked(getAvailableLearnedSkills);
const unlearnSkillMock = vi.mocked(unlearnSkill);

const TEST_AGENT: Agent = {
  id: "a1",
  name: "Atlas",
  name_ko: "아틀라스",
  department_id: "dep-1",
  role: "team_leader",
  cli_provider: "claude",
  avatar_emoji: "🤖",
  personality: null,
  status: "idle",
  current_task_id: null,
  created_at: Date.now(),
};

describe("SkillHistoryPanel unlearn", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("supports unlearning from available skills tab", async () => {
    const onLearningDataChanged = vi.fn();
    getSkillLearningHistoryMock.mockResolvedValue({
      history: [],
      retentionDays: 180,
    });
    getAvailableLearnedSkillsMock
      .mockResolvedValueOnce([
        {
          provider: "claude",
          repo: "superpowers/using-superpowers",
          skill_id: "superpowers:using-superpowers",
          skill_label: "superpowers:using-superpowers",
          learned_at: Date.now(),
        },
      ])
      .mockResolvedValue([]);
    unlearnSkillMock.mockResolvedValueOnce({
      ok: true,
      provider: "claude",
      repo: "superpowers/using-superpowers",
      skill_id: "superpowers:using-superpowers",
      removed: 1,
    });

    render(<SkillHistoryPanel agents={[TEST_AGENT]} onLearningDataChanged={onLearningDataChanged} />);

    fireEvent.click(await screen.findByRole("button", { name: "Available Skills" }));
    fireEvent.click(await screen.findByRole("button", { name: "Unlearn" }));

    await waitFor(() => {
      expect(unlearnSkillMock).toHaveBeenCalledWith({
        provider: "claude",
        repo: "superpowers/using-superpowers",
        skillId: "superpowers:using-superpowers",
      });
      expect(onLearningDataChanged).toHaveBeenCalledTimes(1);
    });
  });
});
