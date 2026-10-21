"use client";

import { useCallback, useEffect, useState } from "react";
import { THEME_STORAGE_KEY, THEME_SYNC_EVENT, type ThemeMode } from "@/components/theme/theme-constants";

const DARK_MEDIA_QUERY = "(prefers-color-scheme: dark)";

function readStoredMode(): ThemeMode {
  if (typeof window === "undefined") return "system";
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  return stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
}

function systemPrefersDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia(DARK_MEDIA_QUERY).matches;
}

function applyResolvedTheme(isDark: boolean) {
  const root = document.documentElement;
  root.classList.toggle("dark", isDark);
  root.style.colorScheme = isDark ? "dark" : "light";
}

/**
 * Shared read/write path for the Light/Dark/System preference — every
 * mounted consumer (the Topbar's ThemeToggle, which is present on every
 * (main) route, and the Settings page's ThemeSettingsCard) calls this same
 * hook rather than touching localStorage/the `dark` class directly, so
 * there is exactly one place that decides what "dark" means for a given
 * mode. Instances sync with each other via THEME_SYNC_EVENT (same-tab) and
 * with the OS via a matchMedia listener (System mode only, live — no
 * refresh needed).
 */
export function useThemePreference() {
  const [mode, setMode] = useState<ThemeMode>("system");
  const [resolvedDark, setResolvedDark] = useState(false);

  useEffect(() => {
    const sync = () => {
      const current = readStoredMode();
      const isDark = current === "dark" || (current === "system" && systemPrefersDark());
      setMode(current);
      setResolvedDark(isDark);
      // Re-asserts the resolved theme on the DOM, not just in React state.
      // theme-script.ts already applies the correct `.dark` class/colorScheme
      // synchronously before first paint — this is normally a no-op. But
      // when a hydration mismatch occurs ANYWHERE else on the page (e.g. a
      // server/client locale-formatting difference), React's hydration
      // recovery regenerates the document tree from the root (the `<html>`
      // element returned by RootLayout), which silently discards the
      // imperatively-added class the inline script set — React never knew
      // about it, since it isn't part of any component's render output. This
      // mount effect re-runs as part of that very regeneration (every
      // (main) page's Topbar — and the root layout's own Toaster — mounts
      // useThemePreference), so reapplying here closes that gap immediately,
      // without a new timer, provider, or page-specific hack.
      applyResolvedTheme(isDark);
    };
    sync();

    window.addEventListener(THEME_SYNC_EVENT, sync);
    window.addEventListener("storage", sync);

    const media = window.matchMedia(DARK_MEDIA_QUERY);
    const onMediaChange = () => {
      // Only matters while in System mode — re-reading `mode` via the
      // closure would be stale, so re-check storage directly.
      if (readStoredMode() === "system") {
        setResolvedDark(systemPrefersDark());
        applyResolvedTheme(systemPrefersDark());
      }
    };
    media.addEventListener("change", onMediaChange);

    return () => {
      window.removeEventListener(THEME_SYNC_EVENT, sync);
      window.removeEventListener("storage", sync);
      media.removeEventListener("change", onMediaChange);
    };
  }, []);

  const setThemeMode = useCallback((next: ThemeMode) => {
    window.localStorage.setItem(THEME_STORAGE_KEY, next);
    const isDark = next === "dark" || (next === "system" && systemPrefersDark());
    applyResolvedTheme(isDark);
    setMode(next);
    setResolvedDark(isDark);
    window.dispatchEvent(new Event(THEME_SYNC_EVENT));
  }, []);

  return {
    mode,
    resolvedTheme: resolvedDark ? ("dark" as const) : ("light" as const),
    setThemeMode,
  };
}
