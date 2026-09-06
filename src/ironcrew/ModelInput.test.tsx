import { I18nProvider } from "../i18n";
import { act, cleanup, fireEvent, render as rtlRender, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import userEvent from "@testing-library/user-event";
import { request } from "../api/core";
import { ModelInput } from "./ModelInput";

vi.mock("../api/core", () => ({ request: vi.fn() }));
const get = vi.mocked(request);
function Input({ runtime = "openrouter" }: { runtime?: string }) {
  const [value, setValue] = useState("");
  return <ModelInput runtime={runtime} aria-label="Modell" value={value} onValueChange={setValue} />;
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
    render(<Input />);
    await screen.findByText(/3 Modelle/);
    fireEvent.click(screen.getByRole("button", { name: "Alle Modelle anzeigen" }));
    expect(within(screen.getByRole("listbox")).getAllByRole("option")).toHaveLength(3);
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
  expect(screen.getByRole("combobox", { name: "Modell" })).toHaveValue("custom/my-model:free");
  expect(get).toHaveBeenCalledTimes(1);
});

const models = [
  {
    id: "anthropic/claude",
    name: "Claude Sonnet",
    contextLength: 200000,
    outputModalities: ["text"],
    inputModalities: ["text", "image"],
    supportedParameters: ["tools"],
  },
  {
    id: "google/gemini:free",
    name: "Gemini Free",
    contextLength: 128000,
    outputModalities: ["text"],
    inputModalities: ["text"],
    supportedParameters: [],
  },
  {
    id: "google/image",
    name: "Gemini Image",
    contextLength: null,
    outputModalities: ["image"],
    inputModalities: ["text"],
    supportedParameters: [],
  },
];
const catalog = { models, fetchedAt: 1700000000000, stale: false };

it("filters all results by name/ID, author and output, and resets without changing the selected ID", async () => {
  get.mockResolvedValue(catalog);
  render(<Input />);
  await screen.findByText(/3 Modelle/);
  const input = screen.getByRole("combobox", { name: "Modell" });
  fireEvent.change(input, { target: { value: "GEMINI google" } });
  expect(within(screen.getByRole("listbox")).getAllByRole("option")).toHaveLength(2);
  fireEvent.change(screen.getByRole("combobox", { name: "Ausgabe" }), { target: { value: "image" } });
  expect(within(screen.getByRole("listbox")).getAllByRole("option")).toHaveLength(1);
  fireEvent.change(screen.getByRole("combobox", { name: "Modellanbieter" }), { target: { value: "anthropic" } });
  expect(screen.getByText(/Keine Treffer/)).toBeInTheDocument();
  expect(input).toHaveValue("GEMINI google");
  fireEvent.click(screen.getByRole("button", { name: "Suche & Filter zurücksetzen" }));
  expect(within(screen.getByRole("listbox")).getAllByRole("option")).toHaveLength(3);
  expect(input).toHaveValue("GEMINI google");
  fireEvent.click(within(screen.getByRole("listbox")).getByRole("option", { name: /google\/image/ }));
  expect(input).toHaveValue("google/image");
  expect(input).toHaveFocus();
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Alle Modelle anzeigen" }));
  expect(within(screen.getByRole("listbox")).getAllByRole("option")).toHaveLength(3);
});

it("supports keyboard completion without submitting the form, and Escape closes only the suggestions", async () => {
  get.mockResolvedValue(catalog);
  const submit = vi.fn((event: React.FormEvent) => event.preventDefault());
  const escape = vi.fn();
  render(
    <form onSubmit={submit} onKeyDown={escape}>
      <Input />
      <button>Save</button>
    </form>,
  );
  await screen.findByText(/3 Modelle/);
  const input = screen.getByRole("combobox", { name: "Modell" });
  fireEvent.change(input, { target: { value: "gemini" } });
  fireEvent.keyDown(input, { key: "ArrowDown" });
  expect(document.getElementById(input.getAttribute("aria-activedescendant")!)).toHaveTextContent("google/gemini:free");
  fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(input).toHaveValue("google/image");
  expect(submit).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Alle Modelle anzeigen" }));
  fireEvent.keyDown(input, { key: "ArrowUp" });
  expect(document.getElementById(input.getAttribute("aria-activedescendant")!)).toHaveTextContent("google/image");
  escape.mockClear();
  fireEvent.keyDown(input, { key: "Escape" });
  expect(escape).not.toHaveBeenCalled();
  expect(input).toHaveAttribute("aria-expanded", "false");
  expect(input).toHaveValue("google/image");
  fireEvent.keyDown(input, { key: "Escape" });
  expect(escape).toHaveBeenCalledOnce();
});

it("does not complete a manual ID on Tab, blur, Enter without navigation, or IME composition", async () => {
  get.mockResolvedValue(catalog);
  render(
    <>
      <Input />
      <button>Outside</button>
    </>,
  );
  await screen.findByText(/3 Modelle/);
  const input = screen.getByRole("combobox", { name: "Modell" });
  fireEvent.change(input, { target: { value: "google/" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(input).toHaveValue("google/");
  fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  expect(input).toHaveValue("google/");
  fireEvent.keyDown(input, { key: "Tab" });
  fireEvent.blur(input, { relatedTarget: screen.getByRole("button", { name: "Outside" }) });
  expect(input).toHaveAttribute("aria-expanded", "false");
  expect(input).toHaveValue("google/");
});

it("refreshes live, keeps the last list on failure and recovers with new models", async () => {
  get
    .mockResolvedValueOnce(catalog)
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce({ ...catalog, models: [...models, { ...models[0], id: "new/model", name: "New model" }] });
  render(<Input />);
  await screen.findByText(/3 Modelle/);
  fireEvent.click(screen.getByRole("button", { name: "Alle Modelle anzeigen" }));
  fireEvent.click(screen.getByRole("button", { name: "Live aktualisieren" }));
  await screen.findByText(/Katalog nicht erreichbar/);
  expect(get).toHaveBeenLastCalledWith("/api/crew/models/openrouter?refresh=1");
  expect(within(screen.getByRole("listbox")).getAllByRole("option")).toHaveLength(3);
  fireEvent.click(screen.getByRole("button", { name: "Live aktualisieren" }));
  await screen.findByText(/^4 Modelle ·/);
  expect(within(screen.getByRole("listbox")).getByRole("option", { name: /new\/model/ })).toBeInTheDocument();
});

it("lists a large catalog without truncation or family restrictions", async () => {
  get.mockResolvedValue({
    ...catalog,
    models: Array.from({ length: 650 }, (_, index) => ({
      ...models[0],
      id: `vendor-${index}/model`,
      name: `Model ${index}`,
    })),
  });
  render(<Input />);
  await screen.findByText(/650 Modelle/);
  fireEvent.click(screen.getByRole("button", { name: "Alle Modelle anzeigen" }));
  expect(within(screen.getByRole("listbox")).getAllByRole("option")).toHaveLength(650);
  fireEvent.change(screen.getByRole("combobox", { name: "Modell" }), { target: { value: "vendor-649" } });
  const result = within(screen.getByRole("listbox")).getByRole("option");
  fireEvent.click(result);
  expect(screen.getByRole("combobox", { name: "Modell" })).toHaveValue("vendor-649/model");
});

it("refreshes every minute only while browsing and coalesces simultaneous inputs", async () => {
  vi.useFakeTimers();
  try {
    get.mockResolvedValue(catalog);
    render(
      <>
        <Input />
        <Input />
      </>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(get).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getAllByRole("button", { name: "Alle Modelle anzeigen" })[0]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(get).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(screen.getAllByRole("combobox", { name: "Modell" })[0], { key: "Escape" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(get).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});

it.each(["disabled", "readOnly"] as const)("does not open or change a %s input", async (attribute) => {
  get.mockResolvedValue(catalog);
  const change = vi.fn();
  render(
    <ModelInput
      runtime="openrouter"
      value="google/image"
      onValueChange={change}
      aria-label="Modell"
      {...{ [attribute]: true }}
    />,
  );
  await screen.findByText(/3 Modelle/);
  const input = screen.getByRole("combobox", { name: "Modell" });
  fireEvent.focus(input);
  fireEvent.keyDown(input, { key: "ArrowDown" });
  expect(input).toHaveAttribute("aria-expanded", "false");
  expect(screen.getByRole("button", { name: "Alle Modelle anzeigen" })).toBeDisabled();
  expect(change).not.toHaveBeenCalled();
});

it("keeps filters usable with real focus transitions and mouse selection", async () => {
  get.mockResolvedValue(catalog);
  const user = userEvent.setup();
  render(
    <>
      <Input />
      <button>Outside</button>
    </>,
  );
  await screen.findByText(/3 Modelle/);
  await user.click(screen.getByRole("button", { name: "Alle Modelle anzeigen" }));
  const input = screen.getByRole("combobox", { name: "Modell" });
  await user.type(input, "gemini");
  await user.selectOptions(screen.getByRole("combobox", { name: "Ausgabe" }), "image");
  expect(within(screen.getByRole("listbox")).getAllByRole("option")).toHaveLength(1);
  await user.click(within(screen.getByRole("listbox")).getByRole("option"));
  expect(input).toHaveValue("google/image");
  expect(input).toHaveFocus();
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Alle Modelle anzeigen" }));
  expect(within(screen.getByRole("listbox")).getAllByRole("option")).toHaveLength(3);
  await user.click(screen.getByRole("button", { name: "Outside" }));
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
});

it("keeps English filters, refresh and empty state localized", async () => {
  get.mockResolvedValue(catalog);
  rtlRender(
    <I18nProvider language="en">
      <Input />
    </I18nProvider>,
  );
  await screen.findByText(/3 models ·/);
  fireEvent.click(screen.getByRole("button", { name: "Show all models" }));
  expect(screen.getByRole("combobox", { name: "Model author" })).toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "Output" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Refresh live" })).toBeInTheDocument();
  expect(screen.getByText(/^Updated:/)).toBeInTheDocument();
  fireEvent.change(screen.getByRole("combobox", { name: "Modell" }), { target: { value: "not-listed" } });
  expect(screen.getByText(/^No matches/)).toBeInTheDocument();
});

it("does not restore a cleared search when returning from a filter to the input", async () => {
  get.mockResolvedValue(catalog);
  const user = userEvent.setup();
  render(<Input />);
  await screen.findByText(/3 Modelle/);
  const input = screen.getByRole("combobox", { name: "Modell" });
  await user.type(input, "gemini");
  await user.click(screen.getByRole("button", { name: "Suche & Filter zurücksetzen" }));
  await user.click(input);
  expect(within(screen.getByRole("listbox")).getAllByRole("option")).toHaveLength(3);
  expect(input).toHaveValue("gemini");
});
