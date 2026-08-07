"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Loader2, Search } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useActiveWorkspace } from "@/components/workspace/active-workspace-provider";
import { ActiveWorkspaceBadge } from "@/components/workspace/active-workspace-badge";
import { ALL_WORKSPACES_VALUE } from "@/types/department";
import type { WorkspaceOption } from "@/types/department";

const SEARCH_DEBOUNCE_MS = 300;

/**
 * Corporate workspace switcher — built on the same DropdownMenu primitives
 * already used identically for the user menu in components/layout/topbar.tsx,
 * so it matches the app's established look without inventing new styling.
 * Only ever lists departments the caller actually has access to (ADMIN sees
 * every active department; everyone else sees their own memberships) —
 * never a department that would just 403 on selection.
 *
 * `departments` from context is already a TAKE-BOUNDED (WORKSPACE_LIST_TAKE,
 * lib/services/workspace-service.ts) initial list, never the full
 * accessible set — a company with hundreds of departments never ships them
 * all to the client. Anything beyond that initial list is found through the
 * search box below, which queries GET /api/workspace/search (server-side
 * `take`+`WHERE name ILIKE`, not a client-side filter/slice of an
 * already-loaded array).
 */
export function WorkspaceSelector() {
  const { departmentId, departments, canViewAllDepartments, isAllSelected, switching, setActiveDepartment } =
    useActiveWorkspace();

  const active = departments.find((d) => d.id === departmentId);
  const activeName = isAllSelected ? "All Workspaces" : (active?.name ?? null);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<WorkspaceOption[] | null>(null);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset search state every time the dropdown closes — reopening always
  // starts from the initial (already-hydrated) list, never stale results
  // from a previous open.
  useEffect(() => {
    if (!open) {
      setQuery("");
      setSearchResults(null);
      setSearching(false);
    }
  }, [open]);

  // Focus the search box on open — this Radix version doesn't expose
  // DropdownMenuContent's onOpenAutoFocus publicly (it's Radix-internal),
  // so a post-open effect is the reliable way to steer focus into the
  // input instead of Radix's own default (the first menu item).
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [open]);

  // Debounced search: one request per pause in typing, never one per
  // keystroke. An empty/whitespace-only query clears search results
  // entirely, restoring the initial list — this IS the "empty search
  // restores initial 20" behavior, not a separate code path.
  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setSearchResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = setTimeout(() => {
      fetch(`/api/workspace/search?q=${encodeURIComponent(trimmed)}`)
        .then((res) => {
          if (!res.ok) throw new Error("Search failed");
          return res.json();
        })
        .then((data) => setSearchResults(Array.isArray(data.workspaces) ? data.workspaces : []))
        .catch(() => setSearchResults([]))
        .finally(() => setSearching(false));
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  // Nothing to switch between — a static badge is the honest UI, an
  // interactive-looking control with one disabled option is not. Cross-
  // department roles always have "All Workspaces" as a real second choice
  // even with a single department, so they never degrade to the badge.
  if (departments.length <= 1 && !canViewAllDepartments) {
    return <ActiveWorkspaceBadge name={active?.name ?? departments[0]?.name ?? null} />;
  }

  const isSearchMode = query.trim().length > 0;
  const showLoading = isSearchMode && searching;
  const searchResultCount = searchResults?.length ?? 0;
  const showNoResults = isSearchMode && !searching && searchResultCount === 0;
  const visibleDepartments = isSearchMode ? (searchResults ?? []) : departments;
  const showList = !showLoading && visibleDepartments.length > 0;

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={switching}
          className="group inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-1.5 shadow-sm transition-colors hover:border-blue-300 hover:bg-blue-50/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <ActiveWorkspaceBadge name={activeName} className="border-0 bg-transparent p-0 shadow-none" />
          {switching ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-slate-400" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5 text-slate-400 transition-transform group-data-[state=open]:rotate-180" />
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72 p-0">
        <DropdownMenuLabel className="px-3 pt-2.5 text-xs font-medium uppercase tracking-wide text-slate-400">
          Switch workspace
        </DropdownMenuLabel>
        <div className="px-2 pb-2 pt-1">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              // Radix's DropdownMenu roving-focus/typeahead would otherwise
              // intercept keystrokes meant for this input (arrow keys,
              // single-character "jump to item" typeahead) — this is a
              // search-first control, not a plain menu.
              onKeyDown={(e) => e.stopPropagation()}
              placeholder="Search workspaces..."
              className="w-full rounded-md border border-slate-200 bg-white py-1.5 pl-8 pr-2 text-sm text-slate-800 outline-none placeholder:text-slate-400 focus:border-blue-300 focus:ring-1 focus:ring-blue-300"
            />
          </div>
        </div>
        <DropdownMenuSeparator />
        {/* Scrollable results panel — capped height so the dropdown never
            grows past a reasonable size regardless of how many results a
            search (or the initial take-bounded list) returns. */}
        <div className="max-h-80 overflow-y-auto p-1">
          {!isSearchMode && canViewAllDepartments && (
            <DropdownMenuItem
              onClick={() => {
                if (!isAllSelected) void setActiveDepartment(ALL_WORKSPACES_VALUE);
              }}
              className="flex items-center justify-between gap-2"
            >
              <span className="truncate font-medium">All Workspaces</span>
              {isAllSelected && <Check className="h-4 w-4 shrink-0 text-blue-600" />}
            </DropdownMenuItem>
          )}

          {showLoading && (
            <div className="flex items-center justify-center gap-2 py-4 text-sm text-slate-400">
              <Loader2 className="h-4 w-4 animate-spin" />
              Searching…
            </div>
          )}

          {showNoResults && (
            <div className="py-4 text-center text-sm text-slate-400">No workspaces found</div>
          )}

          {showList &&
            visibleDepartments.map((d) => (
              <DropdownMenuItem
                key={d.id}
                onClick={() => {
                  if (d.id !== departmentId || isAllSelected) void setActiveDepartment(d.id);
                }}
                className="flex items-center justify-between gap-2"
              >
                <span className="truncate">{d.name}</span>
                {!isAllSelected && d.id === departmentId && <Check className="h-4 w-4 shrink-0 text-blue-600" />}
              </DropdownMenuItem>
            ))}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
