import "@testing-library/jest-dom/vitest";

// Node 26 exposes its own Web Storage globals. Vitest 3 preserves existing
// globals, but browser tests must use this JSDOM window's origin-scoped storage,
// not Node's file-backed localStorage or process-wide sessionStorage.
const browserWindow = (globalThis as typeof globalThis & { jsdom: { window: Window } }).jsdom.window;
for (const key of ["localStorage", "sessionStorage"] as const) {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    get: () => browserWindow[key],
  });
}

// JSDOM does not implement the native dialog top layer. These API stubs only
// expose the open state for component tests; they do NOT simulate focus,
// inertness, Tab navigation or Escape. Browser coverage owns those guarantees.
if (!HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
}
