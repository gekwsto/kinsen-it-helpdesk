"use client";

import { useState, useCallback, useEffect, useTransition } from "react";
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
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { ActivityStatus, ActivityPriority } from "@prisma/client";

const ACTIVITY_STATUS_VALUES = Object.values(ActivityStatus);
const ACTIVITY_PRIORITY_VALUES = Object.values(ActivityPriority);

export interface ActivityFilterOptions {
  projects: { id: string; title: string }[];
  users: { id: string; name: string | null }[];
  departments: { id: string; name: string }[];
}

interface ActivityFiltersProps {
  options: ActivityFilterOptions;
}

/**
 * URL-driven filter bar for the All Activities list — same architecture as
 * components/projects/project-filters.tsx (itself modeled on
 * components/tickets/ticket-filters.tsx): search-submit, quick-filter
 * Selects push straight to the URL, an "advanced" collapsible panel for the
 * rest, a single active-filter-count badge, Reset returns to the bare
 * canonical route. Every push always drops `page`.
 */
export function ActivityFilters({ options }: ActivityFiltersProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();

  const [showAdvanced, setShowAdvanced] = useState(() =>
    !!(
      searchParams.get("status") ||
      searchParams.get("priority") ||
      searchParams.get("assignedUserId") ||
      searchParams.get("unassigned") === "true" ||
      searchParams.get("departmentId") ||
      searchParams.get("subDepartmentId") ||
      searchParams.get("startDateAfter") ||
      searchParams.get("startDateBefore") ||
      searchParams.get("dueDateAfter") ||
      searchParams.get("dueDateBefore")
    )
  );

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

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    push({ search: search || null });
  };

  const handleSelect = (key: string, value: string) => {
    push({ [key]: value === "all" ? null : value });
  };

  const handleDepartmentSelect = (value: string) => {
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
      .then((opts) => setSubDepartments(Array.isArray(opts) ? opts : []))
      .catch(() => setSubDepartments([]));
  }, [selectedDepartmentId]);

  const handleToggle = (key: string, checked: boolean) => {
    push({ [key]: checked ? "true" : null });
  };

  const resetAll = () => {
    setSearch("");
    startTransition(() => {
      router.push(pathname);
    });
  };

  const activeFilterCount = [
    get("status"),
    get("statusGroup"),
    get("overdue") === "true" ? "1" : "",
    get("priority"),
    get("projectId"),
    get("assignedUserId"),
    get("unassigned") === "true" ? "1" : "",
    get("departmentId"),
    get("subDepartmentId"),
    get("startDateAfter"),
    get("startDateBefore"),
    get("dueDateAfter"),
    get("dueDateBefore"),
  ].filter(Boolean).length;

  const hasAnyFilter = !!(get("search") || activeFilterCount > 0);

  return (
    <div className="space-y-3 rounded-lg border bg-card p-4">
      {/* Row 1: Search + Reset */}
      <div className="flex items-center gap-2">
        <form onSubmit={handleSearchSubmit} className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by title or description…"
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

        {hasAnyFilter && (
          <Button variant="ghost" size="sm" className="h-9 text-muted-foreground" onClick={resetAll}>
            <X className="h-3.5 w-3.5 mr-1" />
            Reset
          </Button>
        )}
      </div>

      {/* Row 2: Quick filters */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Completed/Incomplete (terminal-status group) */}
        <Select value={get("statusGroup") || "all"} onValueChange={(v) => handleSelect("statusGroup", v)}>
          <SelectTrigger className="h-8 w-[150px] text-xs">
            <SelectValue placeholder="Completion" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All completion</SelectItem>
            <SelectItem value="incomplete">Incomplete only</SelectItem>
            <SelectItem value="completed">Completed only</SelectItem>
          </SelectContent>
        </Select>

        {/* Project */}
        <Select value={get("projectId") || "all"} onValueChange={(v) => handleSelect("projectId", v)}>
          <SelectTrigger className="h-8 w-[160px] text-xs">
            <SelectValue placeholder="Project" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any project</SelectItem>
            {options.projects.map((p) => (
              <SelectItem key={p.id} value={p.id}>{p.title}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Button
          size="sm"
          variant={get("overdue") === "true" ? "default" : "outline"}
          className="h-8 text-xs"
          onClick={() => handleToggle("overdue", get("overdue") !== "true")}
        >
          Overdue only
        </Button>

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
          {showAdvanced ? <ChevronUp className="h-3 w-3 ml-1" /> : <ChevronDown className="h-3 w-3 ml-1" />}
        </Button>
      </div>

      {showAdvanced && (
        <>
          <Separator />
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
            {/* Exact status */}
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Status</Label>
              <Select value={get("status") || "all"} onValueChange={(v) => handleSelect("status", v)}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue placeholder="Any status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Any status</SelectItem>
                  {ACTIVITY_STATUS_VALUES.map((s) => (
                    <SelectItem key={s} value={s}>{s.replace("_", " ")}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Priority */}
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Priority</Label>
              <Select value={get("priority") || "all"} onValueChange={(v) => handleSelect("priority", v)}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue placeholder="Any priority" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Any priority</SelectItem>
                  {ACTIVITY_PRIORITY_VALUES.map((p) => (
                    <SelectItem key={p} value={p}>{p}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Assignee */}
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Assignee</Label>
              <Select value={get("assignedUserId") || "all"} onValueChange={(v) => handleSelect("assignedUserId", v)}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue placeholder="Any assignee" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Any assignee</SelectItem>
                  {options.users.map((u) => (
                    <SelectItem key={u.id} value={u.id}>{u.name ?? u.id}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Department */}
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Department</Label>
              <Select value={get("departmentId") || "all"} onValueChange={handleDepartmentSelect}>
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

            {selectedDepartmentId && subDepartments.length > 0 && (
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Sub-Department</Label>
                <Select value={get("subDepartmentId") || "all"} onValueChange={(v) => handleSelect("subDepartmentId", v)}>
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

            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Starts after</Label>
              <Input type="date" className="h-8 text-xs" value={get("startDateAfter")} onChange={(e) => push({ startDateAfter: e.target.value || null })} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Starts before</Label>
              <Input type="date" className="h-8 text-xs" value={get("startDateBefore")} onChange={(e) => push({ startDateBefore: e.target.value || null })} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Due after</Label>
              <Input type="date" className="h-8 text-xs" value={get("dueDateAfter")} onChange={(e) => push({ dueDateAfter: e.target.value || null })} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Due before</Label>
              <Input type="date" className="h-8 text-xs" value={get("dueDateBefore")} onChange={(e) => push({ dueDateBefore: e.target.value || null })} />
            </div>
          </div>

          <div className="flex flex-wrap gap-2 pt-1">
            <Button
              size="sm"
              variant={get("unassigned") === "true" ? "default" : "outline"}
              className="h-7 text-xs"
              onClick={() => handleToggle("unassigned", get("unassigned") !== "true")}
            >
              Only unassigned
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
