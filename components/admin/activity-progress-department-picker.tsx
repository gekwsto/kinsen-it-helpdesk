"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface ActivityProgressDepartmentPickerProps {
  departments: { id: string; name: string }[];
  selectedDepartmentId?: string;
}

/** "All Workspaces" department picker for the activity-progress admin page — URL-driven, same convention as every other filter/view control in this app (ViewToggle, ResourcePlanningToolbar). */
export function ActivityProgressDepartmentPicker({ departments, selectedDepartmentId }: ActivityProgressDepartmentPickerProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const setDepartment = (departmentId: string) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("departmentId", departmentId);
    router.push(`${pathname}?${params.toString()}`);
  };

  return (
    <Select value={selectedDepartmentId ?? ""} onValueChange={setDepartment}>
      <SelectTrigger className="h-9 w-[220px] text-sm">
        <SelectValue placeholder="Choose a department…" />
      </SelectTrigger>
      <SelectContent>
        {departments.map((d) => (
          <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
