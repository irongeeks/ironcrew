// Apply theme before React hydrates to prevent flash
(function () {
  var t = localStorage.getItem("octooffice_theme");
  document.documentElement.setAttribute("data-theme", t === "dark" ? "dark" : "light");
})();
