"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Loader2, Network, Users } from "lucide-react";
import { getInitials } from "@/lib/utils";

interface HierarchyMember {
  id: string;
  name: string | null;
  email: string;
  image: string | null;
  roleLabel: string;
  subDepartments: string[];
}

interface HierarchyGroup {
  tier: string;
  label: string;
  members: HierarchyMember[];
}

interface HierarchyResponse {
  department: { id: string; name: string };
  groups: HierarchyGroup[];
}

interface DepartmentHierarchyDialogProps {
  departmentId: string;
  departmentName: string;
}

/**
 * On-demand hierarchy popup — fetches GET /api/departments/[id]/hierarchy
 * only when opened (not preloaded on the /my-departments page), so viewing
 * many department cards never costs a membership-list fetch for ones never
 * opened. SYSTEM_ADMIN renders as a visually separate group above the
 * divider, kept out of the operational Director-down-to-Viewer tree so it
 * never reads as part of that ordering.
 */
export function DepartmentHierarchyDialog({ departmentId, departmentName }: DepartmentHierarchyDialogProps) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<HierarchyResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (next && !data && !loading) {
      setLoading(true);
      setError(null);
      fetch(`/api/departments/${departmentId}/hierarchy`)
        .then(async (res) => {
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error ?? "Failed to load hierarchy");
          }
          return res.json();
        })
        .then((json: HierarchyResponse) => setData(json))
        .catch((e: any) => setError(e.message ?? "Failed to load hierarchy"))
        .finally(() => setLoading(false));
    }
  };

  const systemAdminGroup = data?.groups.find((g) => g.tier === "SYSTEM_ADMIN");
  const operationalGroups = data?.groups.filter((g) => g.tier !== "SYSTEM_ADMIN") ?? [];
  const hasAnyMembers = (data?.groups.length ?? 0) > 0;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <Button size="sm" variant="outline" onClick={() => handleOpenChange(true)}>
        <Network className="h-3.5 w-3.5 mr-1.5" />
        View Hierarchy
      </Button>
      <DialogContent className="max-w-lg max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Department Hierarchy — {departmentName}</DialogTitle>
          <DialogDescription>Active members organized by operational role.</DialogDescription>
        </DialogHeader>

        <div className="overflow-y-auto flex-1 -mx-1 px-1">
          {loading && (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          )}

          {!loading && error && (
            <p className="text-sm text-destructive py-8 text-center">{error}</p>
          )}

          {!loading && !error && !hasAnyMembers && (
            <div className="flex flex-col items-center justify-center gap-2 py-16 text-center text-muted-foreground">
              <Users className="h-8 w-8" />
              <p className="text-sm">No active members in this department.</p>
            </div>
          )}

          {!loading && !error && hasAnyMembers && (
            <div className="space-y-5 py-1">
              {systemAdminGroup && (
                <div className="rounded-lg border border-dashed p-3 space-y-2">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    {systemAdminGroup.label}
                  </p>
                  <div className="space-y-1.5">
                    {systemAdminGroup.members.map((m) => (
                      <MemberRow key={m.id} member={m} />
                    ))}
                  </div>
                </div>
              )}

              {operationalGroups.length > 0 && (
                <div className="space-y-4">
                  {operationalGroups.map((group) => (
                    <div key={group.tier} className="space-y-1.5">
                      <p className="text-sm font-semibold">{group.label}</p>
                      <div className="border-l-2 pl-3 space-y-1.5">
                        {group.members.map((m) => (
                          <MemberRow key={m.id} member={m} />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function MemberRow({ member }: { member: HierarchyMember }) {
  return (
    <div className="flex items-center gap-2.5 rounded-md p-1.5 hover:bg-muted/50 transition-colors">
      <Avatar className="h-7 w-7 flex-shrink-0">
        <AvatarImage src={member.image ?? undefined} />
        <AvatarFallback className="text-[10px]">{getInitials(member.name)}</AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <p className="text-sm font-medium truncate">{member.name ?? member.email}</p>
        </div>
        <p className="text-xs text-muted-foreground truncate">{member.email}</p>
      </div>
      <div className="flex flex-col items-end gap-1 flex-shrink-0">
        <Badge variant="secondary" className="text-[10px] px-1.5 py-0">{member.roleLabel}</Badge>
        {member.subDepartments.length > 0 && (
          <span className="text-[10px] text-muted-foreground truncate max-w-[120px]" title={member.subDepartments.join(", ")}>
            {member.subDepartments.join(", ")}
          </span>
        )}
      </div>
    </div>
  );
}
