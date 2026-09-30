"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";

/**
 * Ticket search from anywhere. Hands off to the ticket list's existing
 * ?search= filter (title, description, requester, and ticket number), so
 * "KIN-123", "123" and free text all work without a new endpoint. Users
 * without All Tickets access search their own requests instead. "/"
 * focuses the field from anywhere outside a text input.
 */
export function GlobalSearch({ canViewAllTickets, autoFocus, onDone }: { canViewAllTickets: boolean; autoFocus?: boolean; onDone?: () => void }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");
  const inputId = useId();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName))) return;
      e.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const raw = value.trim();
    if (!raw) return;
    // "KIN-123" -> "123": the list matches ticket numbers numerically.
    const number = raw.match(/^kin-?\s*(\d+)$/i)?.[1];
    const query = new URLSearchParams({ search: number ?? raw }).toString();
    router.push(`${canViewAllTickets ? "/tickets" : "/tickets/created-by-me"}?${query}`);
    inputRef.current?.blur();
    onDone?.();
  };

  return (
    <form role="search" onSubmit={submit} className="relative w-full max-w-sm">
      <label htmlFor={inputId} className="sr-only">
        Search tickets
      </label>
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
      <input
        ref={inputRef}
        id={inputId}
        type="search"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Search tickets or jump to KIN-…"
        autoComplete="off"
        autoFocus={autoFocus}
        onKeyDown={(e) => e.key === "Escape" && onDone?.()}
        className="h-9 w-full rounded border border-input bg-card pl-9 pr-9 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <kbd
        aria-hidden="true"
        className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded-sm border bg-muted px-1.5 text-[11px] leading-5 text-muted-foreground"
      >
        /
      </kbd>
    </form>
  );
}
