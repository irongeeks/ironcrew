import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CHARACTER_SKINS } from "../shared/character-skins";
import { CharacterSkinEditor } from "./CharacterSkinEditor";
import { CharacterAvatar, resolveCharacterId } from "./CharacterAvatar";
import { buildCharacterPrompt } from "./CharacterPrompt";
import type { Agent } from "./types";

const agent: Agent = {
  id: "agent1",
  key: "engineer",
  displayName: "Forge",
  professionalRole: "engineering",
  roleSummary: "Engineering",
  seniority: "lead",
  departmentId: "engineering",
  runtimeProfile: "coding",
  runtimeProvider: "mock",
  isExecutiveAssistant: false,
  status: "working",
  persona: {
    character_id: "engineer",
    display_name: "Forge",
    accent: "cyan",
    traits: [],
    forbidden_traits: [],
    portrait: null,
    full_body: null,
    model_3d: null,
  },
  policy: {
    may_delegate: false,
    may_create_tasks: true,
    may_approve: false,
    max_risk_level: "low",
    allowed_tools: ["file_read"],
    requires_approval_for: ["production_change"],
  },
};

describe("character appearance editor", () => {
  it("labels the preview state independently of option text and changes it without changing the agent", async () => {
    render(
      <CharacterSkinEditor
        agent={{
          ...agent,
          persona: {
            ...agent.persona,
            animation_config: {
              url: "/api/crew/character-assets/sprite",
              frameWidth: 48,
              frameHeight: 64,
              columns: 2,
              states: { idle: { row: 0, frames: 2, fps: 6, loop: false } },
            },
          },
        }}
        onSave={vi.fn()}
        onUpload={vi.fn()}
      />,
    );
    const state = screen.getByRole<HTMLSelectElement>("combobox", { name: "Vorschauzustand" });
    expect(state.labels?.[0].textContent).toBe("Vorschauzustand");
    expect(screen.getByLabelText("Vorschauzustand", { exact: true })).toBe(state);
    await userEvent.selectOptions(state, "idle");
    expect(state).toHaveValue("idle");
    expect(agent.status).toBe("working");
  });

  it("offers20 distinct presets, previews selection, and saves only cosmetic fields", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<CharacterSkinEditor agent={agent} onSave={onSave} onUpload={vi.fn()} />);
    const buttons = screen.getByRole("group", { name: "Vordefinierte Charaktere" }).querySelectorAll("button");
    expect(buttons).toHaveLength(20);
    expect(new Set(CHARACTER_SKINS.map((s) => s.id)).size).toBe(20);
    fireEvent.click(screen.getByRole("button", { name: /^Kristallwesen:/ }));
    expect(screen.getByRole("img", { name: "Vorschau der Bürofigur" })).toHaveAttribute(
      "data-character-id",
      "crystalline",
    );
    expect(onSave).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Figur speichern" }));
    expect(onSave).toHaveBeenCalledWith({
      character_id: "crystalline",
      portrait: null,
      full_body: null,
      animation_config: null,
      model_3d: null,
    });
    expect(agent.policy.allowed_tools).toEqual(["file_read"]);
    expect(screen.getByRole("status")).toHaveTextContent("Figur gespeichert");
  });

  it("previews a private upload before assigning it and preserves the portrait", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const onUpload = vi.fn().mockResolvedValue("/api/crew/character-assets/private-1");
    render(
      <CharacterSkinEditor
        agent={{ ...agent, persona: { ...agent.persona, portrait: "/api/crew/character-assets/portrait-1" } }}
        onSave={onSave}
        onUpload={onUpload}
      />,
    );
    const file = new File(["imagebytes"], "crew.webp", { type: "image/webp" });
    await userEvent.upload(screen.getByLabelText("Ganzkörperbild für das Büro"), file);
    await waitFor(() =>
      expect(screen.getByRole("img", { name: "Vorschau der Bürofigur" })).toHaveAttribute(
        "data-character-source",
        "upload",
      ),
    );
    expect(onUpload).toHaveBeenCalledWith(file, "full_body");
    expect(onSave).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Figur speichern" }));
    expect(onSave).toHaveBeenCalledWith({
      character_id: "engineer",
      portrait: "/api/crew/character-assets/portrait-1",
      full_body: "/api/crew/character-assets/private-1",
      animation_config: null,
      model_3d: null,
    });
  });

  it("shows backend failures and rejects oversized uploads without claiming success", async () => {
    const onSave = vi.fn().mockRejectedValue(new Error("Freigabe fehlt"));
    const onUpload = vi.fn();
    render(<CharacterSkinEditor agent={agent} onSave={onSave} onUpload={onUpload} />);
    const file = new File([new Uint8Array(5 * 1024 * 1024 + 1)], "large.png", { type: "image/png" });
    await userEvent.upload(screen.getByLabelText("Ganzkörperbild für das Büro"), file);
    expect(screen.getByRole("alert")).toHaveTextContent("höchstens 5 MiB");
    expect(onUpload).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Figur speichern" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Freigabe fehlt");
    expect(screen.queryByText(/Figur gespeichert/)).not.toBeInTheDocument();
  });

  it("keeps celebrity, fictional and original references in a copyable generator prompt", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    try {
      render(<CharacterSkinEditor agent={agent} onSave={vi.fn()} onUpload={vi.fn()} />);
      fireEvent.click(screen.getByText("Prompt für eine eigene Figur erstellen"));
      fireEvent.change(screen.getByLabelText("Gewünschte Figur oder Referenz"), {
        target: { value: "Pamela Anderson, Captain America und ein eigenes Alien" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Generator-Prompt kopieren" }));
      await waitFor(() => expect(writeText).toHaveBeenCalled());
      const prompt = writeText.mock.calls[0][0] as string;
      expect(prompt).toContain("Pamela Anderson, Captain America und ein eigenes Alien");
      expect(prompt).toContain("transparent background (alpha channel)");
      expect(prompt).toContain("92%");
      expect(prompt).toContain("Static base images remain supported");
      expect(buildCharacterPrompt("Captain America", "natural proportions")).toContain("natural proportions");
    } finally {
      if (original) Object.defineProperty(navigator, "clipboard", original);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  it("renders original geometry for every preset and falls back from a broken upload", () => {
    const bodies = CHARACTER_SKINS.map((s) => {
      const { container, unmount } = render(<CharacterAvatar characterId={s.id} />);
      const body = container.querySelector(".crew-office-person-body")!.innerHTML;
      unmount();
      return body;
    });
    expect(new Set(bodies).size).toBe(20);
    const { container } = render(
      <CharacterAvatar characterId="android" fullBodyUrl="/api/crew/character-assets/missing" label="Figur" />,
    );
    fireEvent.error(container.querySelector("image")!);
    expect(screen.getByRole("img", { name: "Figur" })).toHaveAttribute("data-character-source", "preset");
    expect(resolveCharacterId("unrecognised", "crew1")).toBe(resolveCharacterId(null, "crew1"));
  });
});
