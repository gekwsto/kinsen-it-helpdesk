"use client";

import { useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SubDepartmentFilter } from "@/components/workspace/sub-department-filter";
import { UnscheduledPanel } from "@/components/resource-planning/unscheduled-panel";
import { SlidersHorizontal, RotateCcw } from "lucide-react";
import type { ResourceEvent, ResourcePlanningResource } from "@/lib/services/resource-planning-service";
import { ActivityPriority } from "@prisma/client";
import { ACTIVITY_PRIORITY_LABEL } from "@/lib/activity-priority";

const STATUS_OPTIONS = [
  { value: "TODO", label: "To Do" },
  { value: "IN_PROGRESS", label: "In Progress" },
  { value: "ON_HOLD", label: "On Hold" },
  { value: "BLOCKED", label: "Blocked" },
  { value: "COMPLETED", label: "Completed" },
  { value: "CANCELLED", label: "Cancelled" },
];

// Urgency-first, matching lib/activity-priority.ts's canonical ranking —
// not the schema's own LOW..URGENT declaration order.
const PRIORITY_OPTIONS = [ActivityPriority.URGENT, ActivityPriority.HIGH, ActivityPriority.MEDIUM, ActivityPriority.LOW].map(
  (value) => ({ value, label: ACTIVITY_PRIORITY_LABEL[value] })
);

interface ResourcePlanningFiltersProps {
  departments: { id: string; name: string }[];
  selectedDepartmentId: string;
  projects: { id: string; title: string }[];
  selectedProjectId?: string;
  selectedStatus?: string;
  selectedPriority?: string;
  /** Rendered directly under the filter fields at lg+ — see the module doc comment below. */
  unscheduled: ResourceEvent[];
  resources: ResourcePlanningResource[];
}

/**
 * Department/Sub-Department/Project/Status — all URL-driven and applied
 * server-side (see the architecture plan's Decision #2): every change here
 * is a `router.push` that causes the Server Component page to re-fetch via
 * getResourcePlanningData, never a client-only narrowing of an already-
 * loaded dataset.
 *
 * Two-column planning-board shell (resource-planning/page.tsx): this
 * component owns the ENTIRE left rail at lg+ — a Filters card followed
 * directly by the Unscheduled Activities card (same UnscheduledPanel used
 * standalone on mobile, just embedded here so both cards share the rail's
 * fixed width and there's a single source of truth for "what's in the
 * left column" instead of the page assembling it from two places). Below
 * lg, filters live behind a "Filters" button + dialog instead (Unscheduled
 * is rendered separately by the page, stacked below the timeline, on
 * mobile) — a narrow viewport never has to permanently reserve rail width
 * the timeline needs more.
 */
export function ResourcePlanningFilters({
  departments,
  selectedDepartmentId,
  projects,
  selectedProjectId,
  selectedStatus,
  selectedPriority,
  unscheduled,
  resources,
}: ResourcePlanningFiltersProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [mobileOpen, setMobileOpen] = useState(false);

  const push = (updates: Record<string, string | null>) => {
    const params = new URLSearchParams(searchParams.toString());
    for (const [k, v] of Object.entries(updates)) {
      if (v) params.set(k, v);
      else params.delete(k);
    }
    router.push(`${pathname}?${params.toString()}`);
  };

  const handleDepartmentChange = (departmentId: string) => {
    // The old sub-department/project (if any) belong to the previous department.
    push({ departmentId, subDepartmentId: null, projectId: null });
  };

  const activeSubDepartmentId = searchParams.get("subDepartmentId");
  const hasActiveFilters = !!(activeSubDepartmentId || selectedProjectId || selectedStatus || selectedPriority);
  const resetFilters = () => push({ subDepartmentId: null, projectId: null, status: null, priority: null });

  const fields = (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label className="text-xs font-normal text-muted-foreground">Department</Label>
        {departments.length > 1 ? (
          <Select value={selectedDepartmentId} onValueChange={handleDepartmentChange}>
            <SelectTrigger className="h-9 w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {departments.map((d) => (
                <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <p className="h-9 flex items-center px-1 text-sm font-medium">{departments[0]?.name}</p>
        )}
      </div>

      <SubDepartmentFilter departmentId={selectedDepartmentId} triggerClassName="h-9 w-full text-xs" />

      <div className="space-y-1.5">
        <Label className="text-xs font-normal text-muted-foreground">Project</Label>
        <Select value={selectedProjectId || "all"} onValueChange={(v) => push({ projectId: v === "all" ? null : v })}>
          <SelectTrigger className="h-9 w-full text-xs">
            <SelectValue placeholder="Any project" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any project</SelectItem>
            {projects.map((p) => (
              <SelectItem key={p.id} value={p.id}>{p.title}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs font-normal text-muted-foreground">Status</Label>
        <Select value={selectedStatus || "all"} onValueChange={(v) => push({ status: v === "all" ? null : v })}>
          <SelectTrigger className="h-9 w-full text-xs">
            <SelectValue placeholder="Any status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any status</SelectItem>
            {STATUS_OPTIONS.map((s) => (
              <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs font-normal text-muted-foreground">Priority</Label>
        <Select value={selectedPriority || "all"} onValueChange={(v) => push({ priority: v === "all" ? null : v })}>
          <SelectTrigger className="h-9 w-full text-xs">
            <SelectValue placeholder="Any priority" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any priority</SelectItem>
            {PRIORITY_OPTIONS.map((p) => (
              <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {hasActiveFilters && (
        <Button variant="outline" size="sm" className="w-full h-8 text-xs gap-1.5" onClick={resetFilters}>
          <RotateCcw className="h-3.5 w-3.5" />
          Reset filters
        </Button>
      )}
    </div>
  );

  return (
    <>
      {/* Desktop/laptop: the entire left rail — [filters | main timeline] shell. */}
      <aside className="hidden lg:flex lg:w-[300px] lg:flex-shrink-0 flex-col gap-4 self-start lg:sticky lg:top-4">
        <div className="rounded-lg border bg-card p-4 space-y-4">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Filters</p>
          {fields}
        </div>
        <UnscheduledPanel unscheduled={unscheduled} resources={resources} />
      </aside>

      {/* Below lg: filters live behind a button instead of a permanent rail/row. */}
      <div className="lg:hidden">
        <Dialog open={mobileOpen} onOpenChange={setMobileOpen}>
          <Button variant="outline" size="sm" className="h-9 gap-1.5 text-xs" onClick={() => setMobileOpen(true)}>
            <SlidersHorizontal className="h-3.5 w-3.5" />
            Filters
            {hasActiveFilters && <span className="h-1.5 w-1.5 rounded-full bg-primary" />}
          </Button>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>Filters</DialogTitle>
            </DialogHeader>
            {fields}
          </DialogContent>
        </Dialog>
      </div>
    </>
  );
}
