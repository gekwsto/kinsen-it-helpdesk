"use client";

import { useEffect, useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface SubDepartmentFilterProps {
  /** A specific department id, or null/undefined when "All Workspaces" is active — the filter renders nothing in that case (see plan §9: optional filter inside a selected workspace, never a second access-control dimension across All). */
  departmentId: string | null | undefined;
  /** Overrides the trigger's default fixed width (e.g. "w-full" inside a vertical filter rail) — defaults to the original fixed-width horizontal-bar sizing so every existing caller stays pixel-identical. */
  triggerClassName?: string;
}

/**
 * Small, self-contained SubDepartment filter for pages that don't already
 * have a richer filter bar (Projects, Activities) — pushes `?subDepartmentId=`
 * onto the current URL, same convention as the ticket filters' equivalent.
 */
export function SubDepartmentFilter({ departmentId, triggerClassName }: SubDepartmentFilterProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [subDepartments, setSubDepartments] = useState<{ id: string; name: string }[]>([]);

  useEffect(() => {
    if (!departmentId) {
      setSubDepartments([]);
      return;
    }
    fetch(`/api/departments/${departmentId}/sub-departments`)
      .then((r) => (r.ok ? r.json() : []))
      .then((options) => setSubDepartments(Array.isArray(options) ? options : []))
      .catch(() => setSubDepartments([]));
  }, [departmentId]);

  if (!departmentId || subDepartments.length === 0) return null;

  const value = searchParams.get("subDepartmentId") ?? "all";

  const handleChange = (v: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (v === "all") params.delete("subDepartmentId");
    else params.set("subDepartmentId", v);
    router.push(`${pathname}?${params.toString()}`);
  };

  return (
    <Select value={value} onValueChange={handleChange}>
      <SelectTrigger className={triggerClassName ?? "h-9 w-[180px] text-xs"}>
        <SelectValue placeholder="Any sub-department" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">All sub-departments</SelectItem>
        {subDepartments.map((sd) => (
          <SelectItem key={sd.id} value={sd.id}>{sd.name}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
