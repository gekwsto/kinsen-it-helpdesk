import { THEME_STORAGE_KEY } from "@/components/theme/theme-constants";

// Runs synchronously in <head>, before the first paint and before React
// hydrates — applying the `.dark` class here (not in a useEffect) is what
// prevents a light-theme flash for users whose stored preference (or OS
// preference, for "system") is dark. Kept as a plain string (not a .tsx
// component) because it's injected via dangerouslySetInnerHTML, never
// executed as a React component.
export const THEME_INIT_SCRIPT = `
(function () {
  try {
    var key = ${JSON.stringify(THEME_STORAGE_KEY)};
    var stored = localStorage.getItem(key);
    var mode = stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
    var isDark = mode === "dark" || (mode === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    var root = document.documentElement;
    if (isDark) {
      root.classList.add("dark");
    } else {
      root.classList.remove("dark");
    }
    root.style.colorScheme = isDark ? "dark" : "light";
  } catch (e) {}
})();
`;
