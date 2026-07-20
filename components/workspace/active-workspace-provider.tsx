"use client";

import { createContext, useCallback, useContext, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ALL_WORKSPACES_VALUE } from "@/types/department";
import type { DepartmentSummary } from "@/types/department";

interface ActiveWorkspaceContextValue {
  departmentId: string | null;
  departments: DepartmentSummary[];
  isSystemAdmin: boolean;
  /** True for Role.ADMIN or Role.DIRECTOR — offers the "All Workspaces" choice. */
  canViewAllDepartments: boolean;
  /** True when "All Workspaces" is the current selection (departmentId is null in this case). */
  isAllSelected: boolean;
  /** True while a switch is in flight — selector/gate UI can disable itself to avoid double-submits. */
  switching: boolean;
  setActiveDepartment: (departmentId: string) => Promise<void>;
}

const ActiveWorkspaceContext = createContext<ActiveWorkspaceContextValue | null>(null);

interface ActiveWorkspaceProviderProps {
  initialDepartmentId: string | null;
  departments: DepartmentSummary[];
  isSystemAdmin: boolean;
  canViewAllDepartments: boolean;
  initialIsAllSelected: boolean;
  children: React.ReactNode;
}

/**
 * Hydrated from a single server-side getActiveWorkspace() call in
 * app/(main)/layout.tsx. Only exists so client components (the selector,
 * the workspace-gate chooser) can read/switch the active department without
 * prop-drilling — every actual data-scoping decision still happens
 * server-side, re-validated from the cookie on each request. Switching
 * updates local state optimistically (no flicker while the request is in
 * flight) then calls router.refresh() so every Server Component re-reads
 * the now-updated cookie; a failed switch rolls the optimistic update back.
 */
export function ActiveWorkspaceProvider({
  initialDepartmentId,
  departments,
  isSystemAdmin,
  canViewAllDepartments,
  initialIsAllSelected,
  children,
}: ActiveWorkspaceProviderProps) {
  const router = useRouter();
  const [departmentId, setDepartmentId] = useState(initialDepartmentId);
  const [isAllSelected, setIsAllSelected] = useState(initialIsAllSelected);
  const [switching, setSwitching] = useState(false);

  const setActiveDepartment = useCallback(
    async (id: string) => {
      const previousDepartmentId = departmentId;
      const previousIsAllSelected = isAllSelected;
      const nextIsAllSelected = id === ALL_WORKSPACES_VALUE;
      setSwitching(true);
      setDepartmentId(nextIsAllSelected ? null : id);
      setIsAllSelected(nextIsAllSelected);
      try {
        const res = await fetch("/api/workspace/active", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ departmentId: id }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? "Failed to switch workspace");
        }
        router.refresh();
      } catch (error: any) {
        setDepartmentId(previousDepartmentId);
        setIsAllSelected(previousIsAllSelected);
        toast.error(error.message ?? "Failed to switch workspace");
      } finally {
        setSwitching(false);
      }
    },
    [departmentId, isAllSelected, router]
  );

  return (
    <ActiveWorkspaceContext.Provider
      value={{ departmentId, departments, isSystemAdmin, canViewAllDepartments, isAllSelected, switching, setActiveDepartment }}
    >
      {children}
    </ActiveWorkspaceContext.Provider>
  );
}

export function useActiveWorkspace(): ActiveWorkspaceContextValue {
  const ctx = useContext(ActiveWorkspaceContext);
  if (!ctx) throw new Error("useActiveWorkspace must be used within an ActiveWorkspaceProvider");
  return ctx;
}
