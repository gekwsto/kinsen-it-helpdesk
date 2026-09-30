"use client";

import { useState, useEffect, useCallback, useTransition } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Search,
  SlidersHorizontal,
  X,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * `value` is the real, authoritative identifier a Select item resolves to
 * (and what flows into the `statusId`/`priorityId`/`categoryId` URL param)
 * — a single TicketStatus/TicketPriority/TicketCategory id in the common
 * case, or several comma-joined ids when the same name is configured in
 * more than one department (an "All Workspaces" selection). See
 * lib/services/ticket-filter-options-service.ts.
 */
interface TicketFilterOption {
  value: string;
  name: string;
  color: string;
  level?: number;
}

export interface FilterOptions {
  statuses: TicketFilterOption[];
  priorities: TicketFilterOption[];
  categories: TicketFilterOption[];
  departments: { id: string; name: string }[];
  agents: { id: string; name: string | null }[];
  showAssignedToMe?: boolean;
}

interface TicketFiltersProps {
  options: FilterOptions;
  /** All-Tickets-only controls that make sense NOWHERE else: the "Created by me" quick-toggle. Never broadened to gate the assignee filter — see showAssigneeFilter below. */
  isAllTickets?: boolean;
  /**
   * Shows the `Assigned to` dropdown + its "Only unassigned" toggle —
   * independent of `isAllTickets`, so a page can offer the assignee filter
   * without also getting the All-Tickets-only controls (or vice versa).
   * Every page that passes this must also supply `options.agents` (the
   * scoped assignee list — see getScopedTicketAgents in
   * lib/services/ticket-filter-options-service.ts) and handle
   * `assignedAgentId`/`unassigned` in its own server-side where clause;
   * this component only ever renders the control and writes the URL param,
   * never decides visibility itself.
   */
  showAssigneeFilter?: boolean;
  currentUserId?: string;
}

const SORT_OPTIONS = [
  { value: "createdAt", label: "Created Date" },
  { value: "updatedAt", label: "Last Updated" },
  { value: "priority", label: "Priority" },
  { value: "status", label: "Status" },
];

export function TicketFilters({
  options,
  isAllTickets = false,
  showAssigneeFilter = false,
  currentUserId,
}: TicketFiltersProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();
  const [showAdvanced, setShowAdvanced] = useState(() => {
    // Auto-expand if any advanced filter is active
    return !!(
      searchParams.get("categoryId") ||
      searchParams.get("departmentId") ||
      searchParams.get("assignedAgentId") ||
      searchParams.get("source") ||
      searchParams.get("createdAfter") ||
      searchParams.get("createdBefore") ||
      searchParams.get("unassigned") === "true" ||
      searchParams.get("myOnly") === "true"
    );
  });

  const [search, setSearch] = useState(searchParams.get("search") ?? "");

  const get = (key: string) => searchParams.get(key) ?? "";

  const push = useCallback(
    (updates: Record<string, string | null>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [k, v] of Object.entries(updates)) {
        if (v) params.set(k, v);
        else params.delete(k);
      }
      params.delete("page");
      startTransition(() => {
        router.push(`${pathname}?${params.toString()}`);
      });
    },
    [pathname, router, searchParams]
  );

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    push({ search: search || null });
  };

  const handleSelect = (key: string, value: string) => {
    push({ [key]: value === "all" ? null : value });
  };

  const handleDepartmentSelect = (value: string) => {
    // The old sub-department (if any) belongs to the previous department —
    // never valid for a new one, so it's cleared in the same navigation.
    push({ departmentId: value === "all" ? null : value, subDepartmentId: null });
  };

  const [subDepartments, setSubDepartments] = useState<{ id: string; name: string }[]>([]);
  const selectedDepartmentId = get("departmentId");

  useEffect(() => {
    if (!selectedDepartmentId) {
      setSubDepartments([]);
      return;
    }
    fetch(`/api/departments/${selectedDepartmentId}/sub-departments`)
      .then((r) => (r.ok ? r.json() : []))
      .then((options) => setSubDepartments(Array.isArray(options) ? options : []))
      .catch(() => setSubDepartments([]));
  }, [selectedDepartmentId]);

  const handleToggle = (key: string, checked: boolean) => {
    push({ [key]: checked ? "true" : null });
  };

  const handleSortDir = () => {
    const cur = get("sortOrder") || "desc";
    push({ sortOrder: cur === "desc" ? "asc" : "desc" });
  };

  // Changing the sort FIELD always writes an explicit sortOrder alongside
  // it — resolveListSort's own default direction for a recognized sortBy
  // is "asc" (see lib/list-sort.ts), which would otherwise silently
  // override the direction this dropdown is already showing (default
  // "desc") the moment a user just switches criteria without also
  // touching the direction toggle.
  const handleSortBySelect = (value: string) => {
    push({ sortBy: value, sortOrder: get("sortOrder") || "desc" });
  };

  const resetAll = () => {
    setSearch("");
    startTransition(() => {
      router.push(pathname);
    });
  };

  // Count active filters (excluding sort/search)
  const activeFilterCount = [
    get("statusId"),
    get("priorityId"),
    get("categoryId"),
    get("departmentId"),
    get("assignedAgentId"),
    get("source"),
    get("createdAfter"),
    get("createdBefore"),
    get("unassigned") === "true" ? "1" : "",
    get("myOnly") === "true" ? "1" : "",
  ].filter(Boolean).length;

  const hasAnyFilter = !!(
    get("search") ||
    activeFilterCount > 0 ||
    get("sortBy")
  );

  const sortOrder = (get("sortOrder") || "desc") as "asc" | "desc";
  const SortIcon = sortOrder === "asc" ? ArrowUp : ArrowDown;

  return (
    <div className="space-y-3 rounded-md border bg-card p-4">
      {/* Row 1: Search + Sort + Reset */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Full width on phones; sort controls wrap underneath. */}
        <form onSubmit={handleSearch} className="relative min-w-[12rem] flex-1 basis-full sm:basis-0">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by number, title, description, or requester…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 pr-8 h-9"
          />
          {search && (
            <button
              type="button"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              aria-label="Clear search"
              onClick={() => { setSearch(""); push({ search: null }); }}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </form>

        {/* Sort by */}
        <div className="flex items-center gap-1">
          <Select
            value={get("sortBy") || "createdAt"}
            onValueChange={handleSortBySelect}
          >
            <SelectTrigger className="h-9 w-[150px]">
              <ArrowUpDown className="h-3.5 w-3.5 mr-1.5 text-muted-foreground" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SORT_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="icon"
            className="h-9 w-9 flex-shrink-0"
            onClick={handleSortDir}
            title={sortOrder === "desc" ? "Newest first" : "Oldest first"}
          >
            <SortIcon className="h-4 w-4" />
          </Button>
        </div>

        {hasAnyFilter && (
          <Button variant="ghost" size="sm" className="h-9 text-muted-foreground" onClick={resetAll}>
            <X className="h-3.5 w-3.5 mr-1" />
            Reset
          </Button>
        )}
      </div>

      {/* Row 2: Quick filters */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Status (one specific department-owned status row). This is the
            only Status control now — the old coarse "status group"
            selector (Open/In Progress/Closed/All) was removed: it
            independently ANDed a heuristic isClosed/name condition
            alongside whatever specific status a user picked here, and the
            two could silently disagree (e.g. group stuck on a prior
            selection while this picks a status that doesn't match it),
            returning zero rows even for a ticket that visibly matched.
            Status/Closed scoping is now implicit page behavior — see
            app/(main)/tickets/page.tsx — and Closed Tickets has its own
            dedicated page. */}
        <Select
          value={get("statusId") || "all"}
          onValueChange={(v) => handleSelect("statusId", v)}
        >
          <SelectTrigger className="h-8 w-[140px] text-xs">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {options.statuses.map((s) => (
              <SelectItem key={s.value} value={s.value}>
                <span className="flex items-center gap-1.5">
                  <span
                    className="inline-block h-2 w-2 rounded-full flex-shrink-0"
                    style={{ backgroundColor: s.color }}
                  />
                  {s.name}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Priority */}
        <Select
          value={get("priorityId") || "all"}
          onValueChange={(v) => handleSelect("priorityId", v)}
        >
          <SelectTrigger className="h-8 w-[140px] text-xs">
            <SelectValue placeholder="Priority" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All priorities</SelectItem>
            {options.priorities.map((p) => (
              <SelectItem key={p.value} value={p.value}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Advanced toggle */}
        <Button
          variant="outline"
          size="sm"
          className="h-8 text-xs ml-auto"
          onClick={() => setShowAdvanced((v) => !v)}
        >
          <SlidersHorizontal className="h-3.5 w-3.5 mr-1.5" />
          More filters
          {activeFilterCount > 0 && (
            <Badge variant="secondary" className="ml-1.5 h-4 px-1 text-[10px]">
              {activeFilterCount}
            </Badge>
          )}
          {showAdvanced ? (
            <ChevronUp className="h-3 w-3 ml-1" />
          ) : (
            <ChevronDown className="h-3 w-3 ml-1" />
          )}
        </Button>
      </div>

      {/* Advanced filters (collapsible) */}
      {showAdvanced && (
        <>
          <Separator />
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
            {/* Category */}
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Category</Label>
              <Select
                value={get("categoryId") || "all"}
                onValueChange={(v) => handleSelect("categoryId", v)}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue placeholder="Any category" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Any category</SelectItem>
                  {options.categories.map((c) => (
                    <SelectItem key={c.value} value={c.value}>{c.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Department */}
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Department</Label>
              <Select
                value={get("departmentId") || "all"}
                onValueChange={handleDepartmentSelect}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue placeholder="Any department" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Any department</SelectItem>
                  {options.departments.map((d) => (
                    <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Sub-Department — only meaningful once a specific Department is selected */}
            {selectedDepartmentId && subDepartments.length > 0 && (
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Sub-Department</Label>
                <Select
                  value={get("subDepartmentId") || "all"}
                  onValueChange={(v) => handleSelect("subDepartmentId", v)}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue placeholder="Any sub-department" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Any sub-department</SelectItem>
                    {subDepartments.map((sd) => (
                      <SelectItem key={sd.id} value={sd.id}>{sd.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* Assigned to — the user a Ticket's assignedAgentId points to.
                Options come from getVisibleTicketAssignees (see its own doc
                comment): the ACTUAL assignees of Tickets this page's own
                scope+filters can see, never a global role-based user list —
                never a raw name/email match either (the URL/where-clause
                condition is always the stable user id). "Only unassigned"
                below is the equivalent special option this page's filter
                conventions already support, so no separate "Unassigned"
                entry is added to this dropdown. */}
            {showAssigneeFilter && (
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Assigned to</Label>
                <Select
                  value={get("assignedAgentId") || "all"}
                  onValueChange={(v) => handleSelect("assignedAgentId", v)}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue placeholder="All assignees" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All assignees</SelectItem>
                    {options.agents.map((a) => (
                      <SelectItem key={a.id} value={a.id}>{a.name ?? a.id}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* Source */}
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Source</Label>
              <Select
                value={get("source") || "all"}
                onValueChange={(v) => handleSelect("source", v)}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue placeholder="Any source" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Any source</SelectItem>
                  <SelectItem value="WEB">Web</SelectItem>
                  <SelectItem value="EMAIL">Email</SelectItem>
                  <SelectItem value="API">Integration</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Date from */}
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Created after</Label>
              <Input
                type="date"
                className="h-8 text-xs"
                value={get("createdAfter")}
                onChange={(e) => push({ createdAfter: e.target.value || null })}
              />
            </div>

            {/* Date to */}
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Created before</Label>
              <Input
                type="date"
                className="h-8 text-xs"
                value={get("createdBefore")}
                onChange={(e) => push({ createdBefore: e.target.value || null })}
              />
            </div>
          </div>

          {/* Toggles */}
          {(isAllTickets || showAssigneeFilter) && (
            <div className="flex flex-wrap gap-2 pt-1">
              {isAllTickets && currentUserId && (
                <Button
                  size="sm"
                  variant={get("myOnly") === "true" ? "default" : "outline"}
                  className="h-7 text-xs"
                  onClick={() => handleToggle("myOnly", get("myOnly") !== "true")}
                >
                  Created by me
                </Button>
              )}
              {showAssigneeFilter && (
                <Button
                  size="sm"
                  variant={get("unassigned") === "true" ? "default" : "outline"}
                  className="h-7 text-xs"
                  onClick={() => handleToggle("unassigned", get("unassigned") !== "true")}
                >
                  Only unassigned
                </Button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
