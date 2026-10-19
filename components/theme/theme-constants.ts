// Single source of truth for the app's theme preference — the localStorage
// key, the three user-facing modes, and the same-tab sync event name. Kept
// dependency-free (no React) so the blocking FOUC script in app/layout.tsx
// can inline it without a bundler step.
export const THEME_STORAGE_KEY = "kinsen-theme";

export type ThemeMode = "light" | "dark" | "system";

export const THEME_MODES: ThemeMode[] = ["light", "dark", "system"];

// Fired on `window` every time a component writes a new preference to
// localStorage — the only way sibling consumers mounted at the same time
// (the Topbar toggle, which persists across every (main) route, and the
// Settings page card) learn about each other's change without a reload.
// The native "storage" event does NOT fire in the tab that wrote the value,
// only in OTHER tabs — hence this same-tab custom event.
export const THEME_SYNC_EVENT = "kinsen-theme-sync";
