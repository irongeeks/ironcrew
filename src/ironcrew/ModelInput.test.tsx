import { I18nProvider } from "../i18n";
import { cleanup, fireEvent, render as rtlRender, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { request } from "../api/core";
import { ModelInput } from "./ModelInput";

vi.mock("../api/core", () => ({ request: vi.fn() }));
const get = vi.mocked(request);
function Input({ runtime = "openrouter" }: { runtime?: string }) {
  const [value, setValue] = useState("");
  return (
    <ModelInput
      runtime={runtime}
      aria-label="Modell"
      value={value}
      onChange={(event) => setValue(event.target.value)}
    />
  );
}
beforeEach(() => {
  get.mockReset();
});
afterEach(cleanup);

describe("unrestricted model input", () => {
  it("offers every catalog entry and still accepts IDs that are not in the catalog", async () => {
    get.mockResolvedValue({
      fetchedAt: 1,
      stale: false,
      models: [
        { id: "new-vendor/paid", name: "Paid", outputModalities: ["text"] },
        { id: "meta-llama/free:free", name: "Free", outputModalities: ["text"] },
        { id: "new-vendor/image", name: "Image", outputModalities: ["image"] },
      ],
    });
    const { container } = render(<Input />);
    await screen.findByText(/3 Modelle/);
    expect(container.querySelectorAll("datalist option")).toHaveLength(3);
    const input = screen.getByRole("combobox", { name: "Modell" });
    fireEvent.change(input, { target: { value: "tomorrow/new-model:free" } });
    expect(input).toHaveValue("tomorrow/new-model:free");
    expect(input).toBeValid();
    fireEvent.change(input, { target: { value: "new-vendor/image" } });
    expect(screen.getByText(/liefert keine Textausgabe/)).toBeInTheDocument();
    expect(input).toBeValid();
  });

  it("preserves manual entry while loading and when the catalog is unavailable", async () => {
    let reject!: (cause: Error) => void;
    get.mockReturnValue(
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
    );
    render(<Input />);
    expect(screen.getByText(/werden geladen/)).toBeInTheDocument();
    const input = screen.getByRole("combobox", { name: "Modell" });
    fireEvent.change(input, { target: { value: "any-vendor/any-model" } });
    reject(new Error("offline"));
    await screen.findByText(/Katalog nicht erreichbar/);
    expect(input).toHaveValue("any-vendor/any-model");
    expect(input).toBeEnabled();
  });

  it("keeps CLI aliases as plain inputs without querying OpenRouter", () => {
    render(<Input runtime="codex" />);
    const input = screen.getByRole("textbox", { name: "Modell" });
    fireEvent.change(input, { target: { value: "custom-alias" } });
    expect(input).toHaveValue("custom-alias");
    expect(get).not.toHaveBeenCalled();
  });
});

// Existing behavior fixtures explicitly exercise German UI copy.
const render = (ui: Parameters<typeof rtlRender>[0], options?: Parameters<typeof rtlRender>[1]) =>
  rtlRender(ui, { wrapper: ({ children }) => <I18nProvider language="de">{children}</I18nProvider>, ...options });

it("localizes catalog guidance and keeps arbitrary model IDs when the language changes", async () => {
  get.mockResolvedValue({
    fetchedAt: 1,
    stale: true,
    models: [{ id: "new-vendor/paid", name: "Paid", outputModalities: ["text"] }],
  });
  const { rerender } = rtlRender(
    <I18nProvider language="en">
      <Input />
    </I18nProvider>,
  );
  await screen.findByText(/1 models · Search by name or ID/);
  expect(screen.getByText(/Catalog temporarily outdated/)).toBeInTheDocument();
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "custom/my-model:free" } });
  rerender(
    <I18nProvider language="de">
      <Input />
    </I18nProvider>,
  );
  expect(screen.getByText(/1 Modelle · Nach Name oder ID/)).toBeInTheDocument();
  expect(screen.getByRole("combobox")).toHaveValue("custom/my-model:free");
  expect(get).toHaveBeenCalledTimes(1);
});
