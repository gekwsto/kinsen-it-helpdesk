// Plain (non-"use client") module so the root Server Component layout can
// inline the script string; a constant exported from a client module would
// reach the server only as a client reference.
export const THEME_STORAGE_KEY = "kinsen-theme";

/**
 * Runs before first paint (inlined in app/layout.tsx's <head>) so a dark
 * preference never flashes the light theme. Storage access is wrapped
 * because it can throw (blocked site data, private windows).
 */
export const THEME_INIT_SCRIPT = `(function(){try{var p=localStorage.getItem("${THEME_STORAGE_KEY}")||"system";var d=p==="dark"||(p==="system"&&window.matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.classList.toggle("dark",d);document.documentElement.style.colorScheme=d?"dark":"light"}catch(e){}})();`;
