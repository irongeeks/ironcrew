// Apply theme before React hydrates to prevent flash
//
// Reads the current key and falls back to the pre-rename one, because this
// script runs BEFORE the app does — on the first load after an update the
// only value present is still `octooffice_theme`, and `ThemeContext` has not
// had a chance to migrate it yet. Without the fallback a dark-mode user would
// see a white flash on exactly the load that ships the rename; without the
// new key first, they would see one on every load after the migration
// removed the old one.
//
// Kept dependency-free and inline-cheap on purpose: anything this script has
// to wait for is a frame of the wrong colour.
(function () {
  var t = null;
  try {
    t = localStorage.getItem("ironcrew_theme") || localStorage.getItem("octooffice_theme");
  } catch (e) {
    // Private mode or blocked site data: light is the documented default.
  }
  document.documentElement.setAttribute("data-theme", t === "dark" ? "dark" : "light");
})();
