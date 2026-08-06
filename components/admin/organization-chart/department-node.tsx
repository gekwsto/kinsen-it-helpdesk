"use client";

import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { Users, ChevronDown, ChevronRight } from "lucide-react";

export interface DepartmentNodeData {
  [key: string]: unknown;
  label: string;
  isActive: boolean;
  managerName: string | null;
  managerJobTitle: string | null;
  activeUserCount: number;
  childCount: number;
  hasHiddenChildren: boolean;
  isCollapsed: boolean;
  isHighlighted: boolean;
  isSelected: boolean;
  onToggleCollapse: (id: string) => void;
  onSelect: (id: string) => void;
}

export function DepartmentNode({ id, data }: NodeProps) {
  const d = data as DepartmentNodeData;
  return (
    <div
      role="treeitem"
      tabIndex={0}
      aria-label={`Department ${d.label}, ${d.isActive ? "active" : "inactive"}, ${d.activeUserCount} active users`}
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
        "w-[220px] cursor-pointer rounded-lg border bg-card p-3 text-card-foreground shadow-sm transition-colors focus:outline-none focus:ring-2 focus:ring-ring",
        d.isSelected && "border-primary ring-2 ring-primary",
        d.isHighlighted && !d.isSelected && "border-primary/60 bg-primary/5",
        !d.isActive && "opacity-60"
      )}
    >
      <Handle type="target" position={Position.Top} className="!bg-muted-foreground" />
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm font-semibold leading-tight">{d.label}</span>
        <Badge variant={d.isActive ? "default" : "secondary"} className="shrink-0 text-[10px]">
          {d.isActive ? "Active" : "Inactive"}
        </Badge>
      </div>
      {d.managerName && (
        <p className="mt-1 truncate text-xs text-muted-foreground">
          Manager: {d.managerName}
          {d.managerJobTitle ? ` · ${d.managerJobTitle}` : ""}
        </p>
      )}
      <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <Users className="h-3 w-3" />
          {d.activeUserCount}
        </span>
        {d.childCount > 0 && (
          <button
            type="button"
            aria-label={d.isCollapsed ? `Expand ${d.label}` : `Collapse ${d.label}`}
            onClick={(e) => {
              e.stopPropagation();
              d.onToggleCollapse(id);
            }}
            className="flex items-center gap-0.5 rounded px-1 py-0.5 hover:bg-accent hover:text-accent-foreground"
          >
            {d.isCollapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            {d.childCount}
          </button>
        )}
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-muted-foreground" />
    </div>
  );
}
