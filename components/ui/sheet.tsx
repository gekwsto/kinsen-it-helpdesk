"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A left-edge off-canvas drawer — built on the SAME @radix-ui/react-dialog
 * primitive components/ui/dialog.tsx already uses (never a new dependency),
 * just positioned/animated differently. Radix's Dialog already provides
 * everything an accessible drawer needs for free: a focus trap, Escape-to-
 * close, click-outside (overlay) to close, `role="dialog"`/`aria-modal`,
 * background scroll lock while open, and focus restoration to the trigger
 * on close — none of that is re-implemented here.
 */
const Sheet = DialogPrimitive.Root;
const SheetTrigger = DialogPrimitive.Trigger;
const SheetPortal = DialogPrimitive.Portal;
const SheetClose = DialogPrimitive.Close;

const SheetOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      // `md:hidden` here too (not just on SheetContent below) — if the
      // drawer is left open while the viewport grows into the desktop
      // breakpoint (e.g. a window resize, not just an initial load), the
      // backdrop must disappear along with the panel; otherwise it'd be
      // left covering the now-visible desktop Sidebar/page with no way to
      // dismiss it by clicking the (invisible) panel.
      "fixed inset-0 z-50 bg-black/60 md:hidden data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className
    )}
    {...props}
  />
));
SheetOverlay.displayName = DialogPrimitive.Overlay.displayName;

const SheetContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { title: string }
>(({ className, children, title, ...props }, ref) => (
  <SheetPortal>
    <SheetOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        "fixed inset-y-0 left-0 z-50 flex h-full w-72 max-w-[85vw] flex-col border-r bg-sidebar text-sidebar-foreground shadow-lg transition ease-in-out data-[state=closed]:animate-out data-[state=closed]:slide-out-to-left data-[state=open]:animate-in data-[state=open]:slide-in-from-left data-[state=closed]:duration-200 data-[state=open]:duration-300",
        className
      )}
      {...props}
    >
      {/* Visually hidden but required — Radix warns (and screen readers need)
          an accessible name for the dialog; the Sidebar's own visible brand
          header renders inside `children`, so this is never shown twice. */}
      <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
      {children}
      <DialogPrimitive.Close className="absolute right-3 top-3 rounded-lg p-1.5 text-sidebar-foreground/60 opacity-100 ring-offset-background transition-opacity hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:pointer-events-none">
        <X className="h-5 w-5" />
        <span className="sr-only">Close menu</span>
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </SheetPortal>
));
SheetContent.displayName = DialogPrimitive.Content.displayName;

export { Sheet, SheetTrigger, SheetClose, SheetContent };
