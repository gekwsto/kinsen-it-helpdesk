"use client";

import { useState, useCallback, useTransition } from "react";
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

export interface FilterOptions {
  statuses: { id: string; name: string; color: string }[];
  priorities: { id: string; name: string; color: string; level: number }[];
  categories: { id: string; name: string }[];
  departments: { id: string; name: string }[];
  agents: { id: string; name: string | null }[];
  showAssignedToMe?: boolean;
}

interface TicketFiltersProps {
  options: FilterOptions;
  isAllTickets?: boolean;
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

  const handleToggle = (key: string, checked: boolean) => {
    push({ [key]: checked ? "true" : null });
  };

  const handleSortDir = () => {
    const cur = get("sortDir") || "desc";
    push({ sortDir: cur === "desc" ? "asc" : "desc" });
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

  const sortDir = (get("sortDir") || "desc") as "asc" | "desc";
  const SortIcon = sortDir === "asc" ? ArrowUp : ArrowDown;

  return (
    <div className="space-y-3 rounded-lg border bg-card p-4">
      {/* Row 1: Search + Sort + Reset */}
      <div className="flex items-center gap-2">
        <form onSubmit={handleSearch} className="relative flex-1">
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
            onValueChange={(v) => handleSelect("sortBy", v)}
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
            title={sortDir === "desc" ? "Newest first" : "Oldest first"}
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
        {/* Status */}
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
              <SelectItem key={s.id} value={s.id}>
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
              <SelectItem key={p.id} value={p.id}>
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
                    <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Department */}
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Department</Label>
              <Select
                value={get("departmentId") || "all"}
                onValueChange={(v) => handleSelect("departmentId", v)}
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

            {/* Assigned agent (all-tickets only) */}
            {isAllTickets && (
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Agent</Label>
                <Select
                  value={get("assignedAgentId") || "all"}
                  onValueChange={(v) => handleSelect("assignedAgentId", v)}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue placeholder="Any agent" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Any agent</SelectItem>
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
          {isAllTickets && (
            <div className="flex flex-wrap gap-2 pt-1">
              {currentUserId && (
                <Button
                  size="sm"
                  variant={get("myOnly") === "true" ? "default" : "outline"}
                  className="h-7 text-xs"
                  onClick={() => handleToggle("myOnly", get("myOnly") !== "true")}
                >
                  Assigned to me
                </Button>
              )}
              <Button
                size="sm"
                variant={get("unassigned") === "true" ? "default" : "outline"}
                className="h-7 text-xs"
                onClick={() => handleToggle("unassigned", get("unassigned") !== "true")}
              >
                Only unassigned
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
