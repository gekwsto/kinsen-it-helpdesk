import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Users, Ticket, FolderKanban, CheckSquare, Network } from "lucide-react";
import { DepartmentInboundEmailForm } from "@/components/departments/department-inbound-email-form";
import { DepartmentHierarchyDialog } from "@/components/organization/department-hierarchy-dialog";

export interface MyDepartmentRow {
  id: string;
  name: string;
  isActive: boolean;
  roleLabel: string;
  inboundEmail: string | null;
  counts: { members: number; tickets: number; projects: number; activities: number; subDepartments: number };
  canManageMembers: boolean;
  canCreateSubDepartment: boolean;
  canViewSubDepartments: boolean;
  canManageInboundEmail: boolean;
}

export function MyDepartmentsView({ departments }: { departments: MyDepartmentRow[] }) {
  if (departments.length === 0) {
    return (
      <div className="text-center py-20">
        <Network className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
        <p className="text-muted-foreground">You don&apos;t belong to any department yet.</p>
      </div>
    );
  }

  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {departments.map((dept) => (
        <Card key={dept.id} className="h-full">
          <CardHeader className="pb-3">
            <div className="flex items-start justify-between gap-2">
              <CardTitle className="text-base">{dept.name}</CardTitle>
              {!dept.isActive && <Badge variant="outline" className="text-xs text-muted-foreground">Inactive</Badge>}
            </div>
            <CardDescription>{dept.roleLabel}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5"><Users className="h-3.5 w-3.5" /> {dept.counts.members} members</span>
              <span className="flex items-center gap-1.5"><Ticket className="h-3.5 w-3.5" /> {dept.counts.tickets} tickets</span>
              <span className="flex items-center gap-1.5"><FolderKanban className="h-3.5 w-3.5" /> {dept.counts.projects} projects</span>
              <span className="flex items-center gap-1.5"><CheckSquare className="h-3.5 w-3.5" /> {dept.counts.activities} activities</span>
            </div>
            <DepartmentInboundEmailForm
              departmentId={dept.id}
              inboundEmail={dept.inboundEmail}
              canManage={dept.canManageInboundEmail}
              compact
            />
            <div className="flex flex-wrap gap-2">
              {dept.canManageMembers && (
                <Button size="sm" variant="outline" asChild>
                  <Link href={`/admin/departments/${dept.id}/members`}>Manage Members</Link>
                </Button>
              )}
              {dept.canViewSubDepartments && (
                <Button size="sm" variant="outline" asChild>
                  <Link href={`/admin/departments/${dept.id}/sub-departments`}>
                    Sub-Departments ({dept.counts.subDepartments})
                  </Link>
                </Button>
              )}
              <DepartmentHierarchyDialog departmentId={dept.id} departmentName={dept.name} />
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
