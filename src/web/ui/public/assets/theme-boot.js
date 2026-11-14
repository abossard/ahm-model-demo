(function () {
  var stored = null;
  try {
    stored = localStorage.getItem("health-pulse-theme");
  } catch (error) {}
  var explicit = stored === "light" || stored === "dark";
  var dark = typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
  var theme = explicit ? stored : dark ? "dark" : "light";
  document.documentElement.dataset.theme = theme;
  var meta = document.querySelector('meta[name="color-scheme"]');
  if (meta) meta.setAttribute("content", explicit ? theme : "light dark");
})();
