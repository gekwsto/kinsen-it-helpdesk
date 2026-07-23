import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { isAdmin, requireAnyDepartmentPermission, hasAnyDepartmentPermission } from "@/lib/permissions";
import { getActiveWorkspace } from "@/lib/services/workspace-service";
import { listDepartments } from "@/lib/services/department-service";
import { buildCategoryWhere } from "@/lib/services/department-scope-service";
import { NoWorkspaceState, ChooseWorkspaceState } from "@/components/workspace/workspace-gate";
import { WorkspaceConfigManager } from "@/components/admin/workspace-config-manager";

const CATEGORY_MANAGE_KEYS = ["category.manage", "department.manageSettings"];
const CATEGORY_DELETE_KEYS = ["category.delete", ...CATEGORY_MANAGE_KEYS];

export default async function CategoriesAdminPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const activeWorkspace = await getActiveWorkspace(session.user.id, session.user.role);
  const userIsAdmin = isAdmin(session.user.role);

  if (activeWorkspace.isAllSelected) {
    if (!userIsAdmin) redirect("/dashboard");
    const departments = (await listDepartments()).map((d) => ({ id: d.id, name: d.name }));
    const categories = await prisma.ticketCategory.findMany({
      orderBy: { name: "asc" },
      include: { _count: { select: { tickets: true } }, department: { select: { id: true, name: true } } },
    });
    return (
      <PageShell>
        <WorkspaceConfigManager
          entityLabel="Category"
          entityLabelPlural="Categories"
          apiEndpoint="/api/admin/categories"
          items={categories as any}
          fields={CATEGORY_FIELDS}
          extraColumns={CATEGORY_EXTRA_COLUMNS}
          departmentOptions={departments}
          mode="all"
          canCreateGlobal={false}
          deleteSemantics="hard-when-unused"
          canCreate={true}
          canEdit={true}
          canDelete={true}
        />
      </PageShell>
    );
  }

  const departmentId = activeWorkspace.departmentId;
  if (!departmentId) {
    return activeWorkspace.departments.length === 0 ? <NoWorkspaceState /> : <ChooseWorkspaceState departments={activeWorkspace.departments} />;
  }

  let access;
  try {
    access = await requireAnyDepartmentPermission(departmentId, CATEGORY_DELETE_KEYS);
  } catch {
    redirect("/dashboard");
  }

  const categories = await prisma.ticketCategory.findMany({
    where: buildCategoryWhere(departmentId),
    orderBy: { name: "asc" },
    include: { _count: { select: { tickets: true } }, department: { select: { id: true, name: true } } },
  });
  const departmentOptions = userIsAdmin ? (await listDepartments()).map((d) => ({ id: d.id, name: d.name })) : [];
  const [canManage, canDelete] = await Promise.all([
    access.isSystemAdmin || hasAnyDepartmentPermission(access.membership!.role, CATEGORY_MANAGE_KEYS, access.membership!.customRoleId),
    access.isSystemAdmin || hasAnyDepartmentPermission(access.membership!.role, CATEGORY_DELETE_KEYS, access.membership!.customRoleId),
  ]);

  return (
    <PageShell>
      <WorkspaceConfigManager
        entityLabel="Category"
        entityLabelPlural="Categories"
        apiEndpoint="/api/admin/categories"
        items={categories as any}
        fields={CATEGORY_FIELDS}
        extraColumns={CATEGORY_EXTRA_COLUMNS}
        departmentOptions={departmentOptions}
        fixedDepartmentId={userIsAdmin ? undefined : departmentId}
        initialViewDepartmentId={departmentId}
        mode="scoped"
        canCreateGlobal={false}
        deleteSemantics="hard-when-unused"
        canCreate={canManage}
        canEdit={canManage}
        canDelete={canDelete}
      />
    </PageShell>
  );
}

const CATEGORY_FIELDS = [
  { key: "name", label: "Name", type: "text" as const, required: true },
  { key: "description", label: "Description", type: "textarea" as const },
  { key: "color", label: "Color", type: "color" as const },
];

const CATEGORY_EXTRA_COLUMNS = [{ type: "field" as const, header: "Tickets", field: "_count.tickets" }];

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Categories</h1>
        <p className="text-muted-foreground mt-1">
          Manage ticket categories for the current workspace — switch workspace in the top nav to manage another department.
        </p>
      </div>
      {children}
    </div>
  );
}
