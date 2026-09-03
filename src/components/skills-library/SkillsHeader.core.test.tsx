import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import SkillsHeader from "./SkillsHeader";

const t = (text: any) => text.en ?? "";

describe("SkillsHeader core behavior", () => {
  it("renders counters and triggers search/sort/custom-skill actions", () => {
    const onSearchChange = vi.fn();
    const onSortByChange = vi.fn();
    const onOpenCustomSkillModal = vi.fn();

    render(
      <SkillsHeader
        t={t}
        skillsCount={7}
        search=""
        sortBy="rank"
        onSearchChange={onSearchChange}
        onSortByChange={onSortByChange}
        onOpenCustomSkillModal={onOpenCustomSkillModal}
      />,
    );

    expect(screen.getByText("Agent Skills Library")).toBeInTheDocument();
    expect(screen.getByText("Registered skills")).toBeInTheDocument();
    expect(screen.getByText("7")).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("Search skills... (name, repo, category)"), {
      target: { value: "workflow" },
    });
    expect(onSearchChange).toHaveBeenCalledWith("workflow");

    fireEvent.change(screen.getByDisplayValue("By Rank"), { target: { value: "name" } });
    expect(onSortByChange).toHaveBeenCalledWith("name");

    fireEvent.click(screen.getByRole("button", { name: /Add Custom Skill/i }));
    expect(onOpenCustomSkillModal).toHaveBeenCalledTimes(1);
  });
});
