(() => {
  const root = document.documentElement;
  const prefersDark =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches;

  root.dataset.theme = prefersDark ? "dark" : "light";

  if (navigator.language) {
    root.lang = navigator.language.toLowerCase();
  }
})();
