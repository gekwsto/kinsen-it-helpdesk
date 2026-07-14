"use client";

import { createContext, useCallback, useContext, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { DepartmentSummary } from "@/types/department";

interface ActiveWorkspaceContextValue {
  departmentId: string | null;
  departments: DepartmentSummary[];
  isSystemAdmin: boolean;
  /** True while a switch is in flight — selector/gate UI can disable itself to avoid double-submits. */
  switching: boolean;
  setActiveDepartment: (departmentId: string) => Promise<void>;
}

const ActiveWorkspaceContext = createContext<ActiveWorkspaceContextValue | null>(null);

interface ActiveWorkspaceProviderProps {
  initialDepartmentId: string | null;
  departments: DepartmentSummary[];
  isSystemAdmin: boolean;
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
  children,
}: ActiveWorkspaceProviderProps) {
  const router = useRouter();
  const [departmentId, setDepartmentId] = useState(initialDepartmentId);
  const [switching, setSwitching] = useState(false);

  const setActiveDepartment = useCallback(
    async (id: string) => {
      const previous = departmentId;
      setSwitching(true);
      setDepartmentId(id);
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
        setDepartmentId(previous);
        toast.error(error.message ?? "Failed to switch workspace");
      } finally {
        setSwitching(false);
      }
    },
    [departmentId, router]
  );

  return (
    <ActiveWorkspaceContext.Provider value={{ departmentId, departments, isSystemAdmin, switching, setActiveDepartment }}>
      {children}
    </ActiveWorkspaceContext.Provider>
  );
}

export function useActiveWorkspace(): ActiveWorkspaceContextValue {
  const ctx = useContext(ActiveWorkspaceContext);
  if (!ctx) throw new Error("useActiveWorkspace must be used within an ActiveWorkspaceProvider");
  return ctx;
}
