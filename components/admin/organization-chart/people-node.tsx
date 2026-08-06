"use client";

import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { ChevronDown, ChevronRight } from "lucide-react";

export interface PeopleNodeData {
  [key: string]: unknown;
  label: string;
  jobTitle: string | null;
  departmentName: string | null;
  email: string;
  isActive: boolean;
  directReportsCount: number;
  hasHiddenChildren: boolean;
  isCollapsed: boolean;
  isHighlighted: boolean;
  isSelected: boolean;
  onToggleCollapse: (id: string) => void;
  onSelect: (id: string) => void;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase() ?? "").join("") || "?";
}

export function PeopleNode({ id, data }: NodeProps) {
  const d = data as PeopleNodeData;
  return (
    <div
      role="treeitem"
      tabIndex={0}
      aria-label={`${d.label}, ${d.jobTitle ?? "no job title"}, ${d.isActive ? "active" : "inactive"}, ${d.directReportsCount} direct reports`}
      aria-expanded={d.hasHiddenChildren ? !d.isCollapsed : undefined}
      aria-selected={d.isSelected}
      onClick={() => d.onSelect(id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          d.onSelect(id);
        }
      }}
      className={cn(
        "flex w-[240px] cursor-pointer items-center gap-2.5 rounded-lg border bg-card p-2.5 text-card-foreground shadow-sm transition-colors focus:outline-none focus:ring-2 focus:ring-ring",
        d.isSelected && "border-primary ring-2 ring-primary",
        d.isHighlighted && !d.isSelected && "border-primary/60 bg-primary/5",
        !d.isActive && "opacity-60"
      )}
    >
      <Handle type="target" position={Position.Top} className="!bg-muted-foreground" />
      <Avatar className="h-9 w-9 shrink-0">
        <AvatarFallback>{initials(d.label)}</AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-semibold">{d.label}</span>
          {!d.isActive && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground" aria-hidden />}
        </div>
        <p className="truncate text-xs text-muted-foreground">{d.jobTitle ?? "—"}</p>
        <p className="truncate text-[11px] text-muted-foreground">{d.departmentName ?? "No department"}</p>
      </div>
      {d.directReportsCount > 0 && (
        <button
          type="button"
          aria-label={d.isCollapsed ? `Expand ${d.label}'s reports` : `Collapse ${d.label}'s reports`}
          onClick={(e) => {
            e.stopPropagation();
            d.onToggleCollapse(id);
          }}
          className="flex shrink-0 items-center gap-0.5 rounded px-1 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        >
          {d.isCollapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          {d.directReportsCount}
        </button>
      )}
      <Handle type="source" position={Position.Bottom} className="!bg-muted-foreground" />
    </div>
  );
}
