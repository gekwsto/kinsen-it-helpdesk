"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

interface CommandPaletteContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
}

const CommandPaletteContext = createContext<CommandPaletteContextValue | null>(null);

/**
 * Shared open/close state for the global ⌘K palette — the Topbar's trigger
 * button and the palette's own mount point (app/(main)/layout.tsx) are
 * siblings in different branches of the layout tree, not parent/child, so
 * both need this common ancestor to coordinate through. Same reason
 * MobileSidebarProvider already exists in this codebase for the identical
 * structural problem (Topbar's hamburger + Sidebar's drawer).
 */
export function CommandPaletteProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const value = useMemo(() => ({ open, setOpen }), [open]);
  return <CommandPaletteContext.Provider value={value}>{children}</CommandPaletteContext.Provider>;
}

export function useCommandPalette(): CommandPaletteContextValue {
  const ctx = useContext(CommandPaletteContext);
  if (!ctx) throw new Error("useCommandPalette must be used within a CommandPaletteProvider");
  return ctx;
}
