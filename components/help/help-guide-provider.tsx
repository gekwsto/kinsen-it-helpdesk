"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

const LS_KEY = "help-guide-open";

interface HelpGuideContextValue {
  isOpen: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
}

const HelpGuideContext = createContext<HelpGuideContextValue | null>(null);

/**
 * Shared open/close state for the Help Guide, lifted out of the widget
 * itself (which used to own both the trigger button and the panel) so the
 * sidebar's "Help Guide" item and the panel — now siblings in the layout
 * tree, not parent/child — can both act on the exact same state, with no
 * second toggle mechanism. Same pattern as ActiveWorkspaceProvider.
 */
export function HelpGuideProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    try {
      setIsOpen(localStorage.getItem(LS_KEY) === "true");
    } catch {}
  }, []);

  const persist = (next: boolean) => {
    setIsOpen(next);
    try {
      localStorage.setItem(LS_KEY, String(next));
    } catch {}
  };

  const value: HelpGuideContextValue = {
    isOpen,
    open: () => persist(true),
    close: () => persist(false),
    toggle: () => persist(!isOpen),
  };

  return <HelpGuideContext.Provider value={value}>{children}</HelpGuideContext.Provider>;
}

export function useHelpGuide(): HelpGuideContextValue {
  const ctx = useContext(HelpGuideContext);
  if (!ctx) throw new Error("useHelpGuide must be used within HelpGuideProvider");
  return ctx;
}
