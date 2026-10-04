(function () {
  var mode = localStorage.getItem("mode-watcher-mode") || "system";
  var light =
    mode === "light" ||
    (mode === "system" &&
      window.matchMedia("(prefers-color-scheme: light)").matches);
  var root = document.documentElement;
  root.classList.toggle("dark", !light);
  root.style.colorScheme = light ? "light" : "dark";
  localStorage.setItem("mode-watcher-mode", mode);
})();
