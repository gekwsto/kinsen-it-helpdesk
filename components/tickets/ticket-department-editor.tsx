"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";

interface TicketDepartmentEditorProps {
  ticketId: string;
  department: { id: string; name: string } | null;
  subDepartment: { id: string; name: string } | null;
  departments: { id: string; name: string }[];
}

/**
 * Editable Department/SubDepartment pair — only ever rendered when the
 * server has already confirmed the viewer holds ticket.department.change
 * (see canChangeDepartment in app/(main)/tickets/[id]/page.tsx). Everyone
 * else sees the plain read-only labels this replaces.
 */
export function TicketDepartmentEditor({ ticketId, department, subDepartment, departments }: TicketDepartmentEditorProps) {
  const router = useRouter();
  const [selectedDeptId, setSelectedDeptId] = useState(department?.id ?? "");
  const [selectedSubDeptId, setSelectedSubDeptId] = useState(subDepartment?.id ?? "__none__");
  const [subDepartments, setSubDepartments] = useState<Array<{ id: string; name: string }>>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!selectedDeptId) {
      setSubDepartments([]);
      return;
    }
    fetch(`/api/departments/${selectedDeptId}/sub-departments`)
      .then((r) => (r.ok ? r.json() : []))
      .then((options) => setSubDepartments(Array.isArray(options) ? options : []))
      .catch(() => setSubDepartments([]));
  }, [selectedDeptId]);

  const handleDepartmentChange = (v: string) => {
    setSelectedDeptId(v);
    if (v !== department?.id) setSelectedSubDeptId("__none__");
  };

  const hasChanges = selectedDeptId !== (department?.id ?? "") || selectedSubDeptId !== (subDepartment?.id ?? "__none__");

  const handleSave = async () => {
    if (!selectedDeptId) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/tickets/${ticketId}/department`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          departmentId: selectedDeptId,
          subDepartmentId: selectedSubDeptId === "__none__" ? null : selectedSubDeptId,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? "Failed to move ticket");
      }
      toast.success("Ticket moved");
      router.refresh();
    } catch (e: any) {
      toast.error(e.message ?? "Failed to move ticket");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground text-sm">Department</span>
        <Select value={selectedDeptId} onValueChange={handleDepartmentChange}>
          <SelectTrigger className="h-8 w-40 text-xs">
            <SelectValue placeholder="Select…" />
          </SelectTrigger>
          <SelectContent>
            {departments.map((d) => (
              <SelectItem key={d.id} value={d.id} className="text-xs">{d.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground text-sm">Sub-Department</span>
        <Select value={selectedSubDeptId} onValueChange={setSelectedSubDeptId} disabled={subDepartments.length === 0}>
          <SelectTrigger className="h-8 w-40 text-xs">
            <SelectValue placeholder="None" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__" className="text-xs">None</SelectItem>
            {subDepartments.map((sd) => (
              <SelectItem key={sd.id} value={sd.id} className="text-xs">{sd.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {hasChanges && (
        <Button size="sm" className="w-full" onClick={handleSave} disabled={saving}>
          {saving && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
          Save move
        </Button>
      )}
    </div>
  );
}
