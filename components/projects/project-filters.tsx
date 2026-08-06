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
import { ProjectStatus } from "@prisma/client";
import { PROJECT_PRIORITY_LABEL } from "@/lib/project-priority";

const PROJECT_STATUS_LABEL: Record<ProjectStatus, string> = {
  PLANNING: "Planning",
  IN_PROGRESS: "In Progress",
  ON_HOLD: "On Hold",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
};
const PROJECT_STATUS_VALUES = Object.values(ProjectStatus);

export interface ProjectFilterOptions {
  departments: { id: string; name: string }[];
  users: { id: string; name: string | null }[];
}

interface ProjectFiltersProps {
  options: ProjectFilterOptions;
}

/**
 * URL-driven filter bar for the All Projects list — same architecture as
 * components/tickets/ticket-filters.tsx (search debounced via a form submit,
 * quick-filter Selects push straight to the URL, an "advanced" collapsible
 * panel for the rest, a single active-filter-count badge, Reset returns to
 * the bare canonical route) so the two lists behave identically from a
 * user's perspective. Every push always drops `page` (a filter change
 * invalidates whatever the current page meant) — matches TicketFilters'
 * `push()` exactly.
 */
export function ProjectFilters({ options }: ProjectFiltersProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();

  const [showAdvanced, setShowAdvanced] = useState(() =>
    !!(
      searchParams.get("status") ||
      searchParams.get("priority") ||
      searchParams.get("ownerId") ||
      searchParams.get("memberId") ||
      searchParams.get("departmentId") ||
      searchParams.get("subDepartmentId") ||
      searchParams.get("startDateAfter") ||
      searchParams.get("startDateBefore") ||
      searchParams.get("dueDateAfter") ||
      searchParams.get("dueDateBefore") ||
      searchParams.get("createdAfter") ||
      searchParams.get("createdBefore") ||
      searchParams.get("hasActivities") === "true" ||
      searchParams.get("activityStatus") ||
      searchParams.get("activityOverdue") === "true"
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
    get("ownerId"),
    get("memberId"),
    get("departmentId"),
    get("subDepartmentId"),
    get("startDateAfter"),
    get("startDateBefore"),
    get("dueDateAfter"),
    get("dueDateBefore"),
    get("createdAfter"),
    get("createdBefore"),
    get("hasActivities") === "true" ? "1" : "",
    get("activityStatus"),
    get("activityOverdue") === "true" ? "1" : "",
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
        {/* Active/Completed (terminal-status group) */}
        <Select value={get("statusGroup") || "all"} onValueChange={(v) => handleSelect("statusGroup", v)}>
          <SelectTrigger className="h-8 w-[140px] text-xs">
            <SelectValue placeholder="Active/Completed" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Active + Completed</SelectItem>
            <SelectItem value="active">Active only</SelectItem>
            <SelectItem value="completed">Completed only</SelectItem>
          </SelectContent>
        </Select>

        {/* Priority */}
        <Select value={get("priority") || "all"} onValueChange={(v) => handleSelect("priority", v)}>
          <SelectTrigger className="h-8 w-[130px] text-xs">
            <SelectValue placeholder="Priority" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All priorities</SelectItem>
            {[3, 2, 1].map((p) => (
              <SelectItem key={p} value={String(p)}>{PROJECT_PRIORITY_LABEL[p]}</SelectItem>
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
                  {PROJECT_STATUS_VALUES.map((s) => (
                    <SelectItem key={s} value={s}>{PROJECT_STATUS_LABEL[s]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Owner */}
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Owner</Label>
              <Select value={get("ownerId") || "all"} onValueChange={(v) => handleSelect("ownerId", v)}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue placeholder="Any owner" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Any owner</SelectItem>
                  {options.users.map((u) => (
                    <SelectItem key={u.id} value={u.id}>{u.name ?? u.id}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Member */}
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Member</Label>
              <Select value={get("memberId") || "all"} onValueChange={(v) => handleSelect("memberId", v)}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue placeholder="Any member" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Any member</SelectItem>
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

            {/* Start date range */}
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Starts after</Label>
              <Input type="date" className="h-8 text-xs" value={get("startDateAfter")} onChange={(e) => push({ startDateAfter: e.target.value || null })} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Starts before</Label>
              <Input type="date" className="h-8 text-xs" value={get("startDateBefore")} onChange={(e) => push({ startDateBefore: e.target.value || null })} />
            </div>

            {/* Due date range */}
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Due after</Label>
              <Input type="date" className="h-8 text-xs" value={get("dueDateAfter")} onChange={(e) => push({ dueDateAfter: e.target.value || null })} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Due before</Label>
              <Input type="date" className="h-8 text-xs" value={get("dueDateBefore")} onChange={(e) => push({ dueDateBefore: e.target.value || null })} />
            </div>

            {/* Created date range */}
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Created after</Label>
              <Input type="date" className="h-8 text-xs" value={get("createdAfter")} onChange={(e) => push({ createdAfter: e.target.value || null })} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Created before</Label>
              <Input type="date" className="h-8 text-xs" value={get("createdBefore")} onChange={(e) => push({ createdBefore: e.target.value || null })} />
            </div>
          </div>

          {/* Activity-based toggles */}
          <div className="flex flex-wrap gap-2 pt-1">
            <Button
              size="sm"
              variant={get("hasActivities") === "true" ? "default" : "outline"}
              className="h-7 text-xs"
              onClick={() => handleToggle("hasActivities", get("hasActivities") !== "true")}
            >
              Has activities
            </Button>
            <Select value={get("activityStatus") || "any"} onValueChange={(v) => handleSelect("activityStatus", v === "any" ? "all" : v)}>
              <SelectTrigger className="h-7 w-[190px] text-xs">
                <SelectValue placeholder="Activity completion" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="any">Any activity completion</SelectItem>
                <SelectItem value="completed">Has completed activity</SelectItem>
                <SelectItem value="incomplete">Has incomplete activity</SelectItem>
              </SelectContent>
            </Select>
            <Button
              size="sm"
              variant={get("activityOverdue") === "true" ? "default" : "outline"}
              className="h-7 text-xs"
              onClick={() => handleToggle("activityOverdue", get("activityOverdue") !== "true")}
            >
              Has overdue activity
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
