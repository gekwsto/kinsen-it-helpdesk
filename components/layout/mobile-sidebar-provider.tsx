"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";

// Must match Tailwind's own unmodified `md:` breakpoint exactly (see
// tailwind.config.ts — only custom maxh-800/maxh-700 height screens were
// ever added there; the default width screens, including `md` at 768px,
// were never overridden). This is the ONE place that value is duplicated
// as a JS literal — CSS media queries can't be read back from Tailwind's
// config at runtime, so there's no way to derive it instead of restating
// it; if `md` is ever redefined, this constant has to move with it.
const DESKTOP_BREAKPOINT_QUERY = "(min-width: 768px)";

interface MobileSidebarContextValue {
  isOpen: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
  /**
   * The hamburger button's own DOM node (set by the Topbar, read by the
   * Sidebar's drawer) — exists purely so the drawer can restore keyboard
   * focus to the EXACT control that opened it when it closes. Radix
   * Dialog's `Content` does this automatically for free when its trigger
   * is rendered via `<Dialog.Trigger>`, but here the trigger (Topbar) and
   * the content (Sidebar) are sibling components, not nested — Radix has
   * no way to know about a trigger it never rendered, so the drawer's own
   * `onCloseAutoFocus` has to point at it explicitly instead.
   */
  triggerRef: RefObject<HTMLButtonElement | null>;
}

const MobileSidebarContext = createContext<MobileSidebarContextValue | null>(null);

/**
 * Shared open/close state for the mobile off-canvas Sidebar drawer — the
 * hamburger trigger lives in the Topbar, the drawer itself in the Sidebar;
 * as siblings in the layout tree (not parent/child), both need the same
 * state. Same pattern as HelpGuideProvider/ActiveWorkspaceProvider.
 *
 * Deliberately NOT persisted to localStorage (unlike the desktop Sidebar's
 * own collapsed/expanded state) — a drawer should always start closed on a
 * fresh navigation/load, never reopen itself from a stale value.
 */
export function MobileSidebarProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  // CSS alone (`md:hidden` on both the drawer panel and its backdrop —
  // see components/ui/sheet.tsx) already hides the mobile drawer at
  // desktop width, but that's purely visual: Radix's Dialog is still
  // "open" as far as its own internal state is concerned, so its focus
  // trap and background-scroll-lock (both driven by the `open` prop, not
  // by whether anything is actually visible) stay active — e.g. resizing
  // a browser window from mobile to desktop width without closing the
  // drawer first would otherwise leave scrolling/keyboard interaction
  // broken on a page that now looks completely normal. `matchMedia`'s
  // `change` event (not a resize listener + manual width math, and never
  // a poll) fires exactly when the viewport crosses the breakpoint in
  // either direction; closing the drawer here just flips `isOpen` to
  // false the same way any other close path already does, so Radix
  // releases the trap/lock through its own normal close handling — no
  // separate trap/lock-release code is needed.
  useEffect(() => {
    const mql = window.matchMedia(DESKTOP_BREAKPOINT_QUERY);
    const handleChange = (e: MediaQueryListEvent | MediaQueryList) => {
      if (e.matches) setIsOpen(false);
    };
    handleChange(mql);
    mql.addEventListener("change", handleChange);
    return () => mql.removeEventListener("change", handleChange);
  }, []);

  const value: MobileSidebarContextValue = {
    isOpen,
    open: () => setIsOpen(true),
    close: () => setIsOpen(false),
    toggle: () => setIsOpen((prev) => !prev),
    triggerRef,
  };

  return <MobileSidebarContext.Provider value={value}>{children}</MobileSidebarContext.Provider>;
}

export function useMobileSidebar(): MobileSidebarContextValue {
  const ctx = useContext(MobileSidebarContext);
  if (!ctx) throw new Error("useMobileSidebar must be used within MobileSidebarProvider");
  return ctx;
}
