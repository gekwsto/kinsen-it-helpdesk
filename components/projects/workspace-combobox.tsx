"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronsUpDown, Loader2, Search } from "lucide-react";
import { cn } from "@/lib/utils";

export interface WorkspaceComboboxOption {
  id: string;
  name: string;
}

const REMOTE_SEARCH_DEBOUNCE_MS = 300;

interface WorkspaceComboboxProps {
  workspaces: WorkspaceComboboxOption[];
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
  placeholder?: string;
  /** Forwarded to the trigger button — lets a caller's <Label htmlFor> keep pointing at a real element, same as the <SelectTrigger id="..."> this replaces. */
  id?: string;
  /**
   * Optional — when the initial `workspaces` list is itself bounded
   * server-side (e.g. the Project Request form's Department list, capped
   * at WORKSPACE_LIST_TAKE — see lib/services/workspace-service.ts), a
   * genuinely eligible option might not be in it at all. Providing this
   * lets the combobox reach beyond that initial list once the user types
   * a non-empty query (debounced, same pattern as
   * components/workspace/workspace-selector.tsx's own search). The
   * function MUST return the exact same eligibility set the caller
   * already trusts — this component never decides eligibility itself,
   * only renders/merges what it's given. Omit when `workspaces` is
   * already the complete candidate set (e.g. manual Project creation's
   * own, unbounded `departments` prop) — the combobox then stays a pure,
   * zero-network client-side filter, exactly as before.
   */
  remoteSearch?: (query: string) => Promise<WorkspaceComboboxOption[]>;
}

/**
 * Searchable Workspace/Department picker — the SAME self-contained
 * combobox pattern already established by
 * components/admin/business-unit-combobox.tsx (see that component's own
 * doc comment: this app has no shared combobox/command primitive, so each
 * one stays narrowly-scoped rather than inventing a premature shared
 * abstraction). A pure presentation swap for the plain Select it
 * replaces — `workspaces` is still exactly the same server-resolved,
 * permission-scoped candidate list the caller already had; this component
 * never decides eligibility, it only searches/renders it (optionally
 * reaching further via `remoteSearch`, under the exact same rule).
 */
export function WorkspaceCombobox({ workspaces, value, onChange, disabled, placeholder = "Choose a workspace…", id, remoteSearch }: WorkspaceComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [remoteResults, setRemoteResults] = useState<WorkspaceComboboxOption[] | null>(null);
  const [searching, setSearching] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Every option ever seen (the initial list, plus anything a remote
  // search has returned) — needed so the trigger can still display the
  // selected NAME after closing the popover even when that option came
  // from `remoteSearch` and was never part of the initial `workspaces`
  // prop. Only ever grows, never drops an entry.
  const [knownOptions, setKnownOptions] = useState<WorkspaceComboboxOption[]>(workspaces);
  useEffect(() => {
    setKnownOptions((prev) => {
      const byId = new Map(prev.map((w) => [w.id, w]));
      for (const w of workspaces) byId.set(w.id, w);
      return Array.from(byId.values());
    });
  }, [workspaces]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    function handleEscape(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, []);

  // Closing (by any path — selection, Escape, click-outside) always drops
  // the search query, same as business-unit-combobox.tsx: reopening starts
  // from the full list, never stale filtered results from a previous open.
  useEffect(() => {
    if (!open) {
      setQuery("");
      setRemoteResults(null);
    }
  }, [open]);

  // Debounced remote search — only ever runs for a non-empty query, and
  // only when the caller actually provided one. An empty query always
  // falls back to the plain, already-loaded `workspaces` list immediately
  // (never waits on a request) — satisfying "clearing search restores the
  // full eligible list" without delay.
  useEffect(() => {
    if (!remoteSearch) return;
    const q = query.trim();
    if (!q) {
      setRemoteResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const handle = setTimeout(() => {
      remoteSearch(q)
        .then((results) => {
          setRemoteResults(results);
          setKnownOptions((prev) => {
            const byId = new Map(prev.map((w) => [w.id, w]));
            for (const w of results) byId.set(w.id, w);
            return Array.from(byId.values());
          });
        })
        .catch(() => setRemoteResults([]))
        .finally(() => setSearching(false));
    }, REMOTE_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [query, remoteSearch]);

  const selected = knownOptions.find((w) => w.id === value) ?? null;

  const trimmedQuery = query.trim();
  const localFiltered = trimmedQuery
    ? workspaces.filter((w) => w.name.toLowerCase().includes(trimmedQuery.toLowerCase()))
    : workspaces;
  // Local (already-loaded) matches merged with whatever the remote search
  // has found so far for this exact query — never a replacement, since the
  // initial list is still valid data, just possibly incomplete.
  const filtered = (() => {
    if (!trimmedQuery || !remoteSearch || !remoteResults) return localFiltered;
    const byId = new Map(localFiltered.map((w) => [w.id, w]));
    for (const w of remoteResults) byId.set(w.id, w);
    return Array.from(byId.values());
  })();

  return (
    <div className="relative" ref={containerRef}>
      <button
        id={id}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className="flex h-9 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span className={cn("truncate text-left", !selected && "text-muted-foreground")}>
          {selected ? selected.name : placeholder}
        </span>
        <ChevronsUpDown className="h-4 w-4 opacity-50 flex-shrink-0 ml-2" />
      </button>

      {open && (
        <div className="absolute z-50 mt-1 w-full rounded-md border bg-popover text-popover-foreground shadow-md">
          <div className="flex items-center border-b px-2">
            <Search className="h-3.5 w-3.5 text-muted-foreground mr-2 flex-shrink-0" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search workspaces…"
              className="flex h-9 w-full bg-transparent py-2 text-sm outline-none placeholder:text-muted-foreground"
            />
            {searching && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground flex-shrink-0" />}
          </div>
          <div role="listbox" className="max-h-64 overflow-y-auto p-1">
            {workspaces.length === 0 ? (
              <p className="px-2 py-4 text-center text-sm text-muted-foreground">No workspaces available.</p>
            ) : filtered.length === 0 ? (
              <p className="px-2 py-4 text-center text-sm text-muted-foreground">
                {searching ? "Searching…" : "No workspaces match your search."}
              </p>
            ) : (
              filtered.map((w) => (
                <button
                  key={w.id}
                  type="button"
                  role="option"
                  aria-selected={w.id === value}
                  onClick={() => {
                    onChange(w.id);
                    setOpen(false);
                  }}
                  className={cn(
                    "flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-sm text-left hover:bg-accent hover:text-accent-foreground",
                    w.id === value && "bg-accent/50"
                  )}
                >
                  <span className="truncate">{w.name}</span>
                  {w.id === value && <Check className="h-3.5 w-3.5 flex-shrink-0 ml-2" />}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
