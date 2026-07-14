"use client";

import { Building2, ShieldOff } from "lucide-react";
import { useActiveWorkspace } from "@/components/workspace/active-workspace-provider";
import type { DepartmentSummary } from "@/types/department";

/** Zero accessible departments — pending setup, not a crash. */
export function NoWorkspaceState() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] text-center gap-4">
      <ShieldOff className="h-12 w-12 text-muted-foreground" />
      <h1 className="text-xl font-semibold">No department access yet</h1>
      <p className="text-muted-foreground text-sm max-w-sm">
        Your account isn&apos;t assigned to a department yet. Contact an administrator to get access.
      </p>
    </div>
  );
}

/**
 * 2+ accessible departments, none currently active (no cookie, no primary
 * membership) — per Phase 1's resolveActiveWorkspace contract, this is
 * exactly the state that means "ask the user to pick one," not a place to
 * silently guess. Reuses the same setActiveDepartment the topbar selector
 * uses, so the two pick-a-workspace paths stay identical.
 */
export function ChooseWorkspaceState({ departments }: { departments: DepartmentSummary[] }) {
  const { switching, setActiveDepartment } = useActiveWorkspace();

  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] text-center gap-5">
      <Building2 className="h-12 w-12 text-muted-foreground" />
      <div>
        <h1 className="text-xl font-semibold">Choose a workspace</h1>
        <p className="text-muted-foreground text-sm max-w-sm mt-1">
          You have access to multiple departments. Pick one to continue.
        </p>
      </div>
      <div className="flex flex-wrap justify-center gap-2 max-w-lg">
        {departments.map((d) => (
          <button
            key={d.id}
            type="button"
            disabled={switching}
            onClick={() => void setActiveDepartment(d.id)}
            className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-800 shadow-sm transition-colors hover:border-blue-300 hover:bg-blue-50/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {d.name}
          </button>
        ))}
      </div>
    </div>
  );
}
