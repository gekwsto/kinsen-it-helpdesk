"use client";

import { Check, ChevronDown, Loader2 } from "lucide-react";
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

/**
 * Corporate workspace switcher — built on the same DropdownMenu primitives
 * already used identically for the user menu in components/layout/topbar.tsx,
 * so it matches the app's established look without inventing new styling.
 * Only ever lists departments the caller actually has access to (ADMIN sees
 * every active department; everyone else sees their own memberships) —
 * never a department that would just 403 on selection.
 */
export function WorkspaceSelector() {
  const { departmentId, departments, switching, setActiveDepartment } = useActiveWorkspace();

  const active = departments.find((d) => d.id === departmentId);

  // Nothing to switch between — a static badge is the honest UI, an
  // interactive-looking control with one disabled option is not.
  if (departments.length <= 1) {
    return <ActiveWorkspaceBadge name={active?.name ?? departments[0]?.name ?? null} />;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={switching}
          className="group inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-1.5 shadow-sm transition-colors hover:border-blue-300 hover:bg-blue-50/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <ActiveWorkspaceBadge name={active?.name ?? null} className="border-0 bg-transparent p-0 shadow-none" />
          {switching ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-slate-400" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5 text-slate-400 transition-transform group-data-[state=open]:rotate-180" />
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel className="text-xs font-medium uppercase tracking-wide text-slate-400">
          Switch workspace
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {departments.map((d) => (
          <DropdownMenuItem
            key={d.id}
            onClick={() => {
              if (d.id !== departmentId) void setActiveDepartment(d.id);
            }}
            className="flex items-center justify-between gap-2"
          >
            <span className="truncate">{d.name}</span>
            {d.id === departmentId && <Check className="h-4 w-4 shrink-0 text-blue-600" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
