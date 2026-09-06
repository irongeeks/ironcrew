import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "../i18n";
import LocalizedText, { useUiCopy } from "./LocalizedText";
import { cronToHuman } from "./schedules/CronPicker";

function Example({ onChange }: { onChange: (value: string) => void }) {
  const copy = useUiCopy();
  return (
    <label>
      <LocalizedText en="State" de="Status" />
      <select aria-label={copy("State", "Status")} defaultValue="idle" onChange={(e) => onChange(e.target.value)}>
        <option value="idle">
          <LocalizedText en="Idle" de="Bereit" />
        </option>
        <option value="working">
          <LocalizedText en="Working" de="Arbeitet" />
        </option>
      </select>
    </label>
  );
}

describe("source-owned UI localization", () => {
  it("switches visible and accessible labels without translating stored values", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <I18nProvider language="de">
        <Example onChange={onChange} />
      </I18nProvider>,
    );
    const select = screen.getByRole("combobox", { name: "Status" });
    expect(screen.getByRole("option", { name: "Bereit" })).toHaveValue("idle");
    fireEvent.change(select, { target: { value: "working" } });
    expect(onChange).toHaveBeenCalledWith("working");
    rerender(
      <I18nProvider language="en">
        <Example onChange={onChange} />
      </I18nProvider>,
    );
    expect(screen.getByRole("combobox", { name: "State" })).toHaveValue("working");
    expect(screen.getByRole("option", { name: "Working" })).toBeInTheDocument();
  });

  it("formats recurring schedule descriptions in the selected language", () => {
    expect(cronToHuman("30 9 * * *", "de")).toBe("Täglich um 09:30");
    expect(cronToHuman("30 9 * * 1", "de")).toBe("Jeden Montag um 09:30");
    expect(cronToHuman("30 9 2 * *", "de")).toBe("Monatlich am 2. um 09:30");
    expect(cronToHuman("30 9 * * *", "en")).toBe("Every day at 09:30");
  });
});
