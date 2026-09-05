import "@testing-library/jest-dom/vitest";

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
