import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/permissions";
import { redirect } from "next/navigation";
import { UserManagement } from "@/components/admin/user-management";

export default async function UsersAdminPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  try {
    await requireAdmin();
  } catch {
    redirect("/dashboard");
  }

  const [users, departments, businessUnits] = await Promise.all([
    prisma.user.findMany({
      orderBy: { name: "asc" },
      include: {
        department: { select: { id: true, name: true } },
        businessUnit: { select: { id: true, name: true } },
        customRole: { select: { id: true, key: true, name: true } },
        departmentMemberships: {
          include: { department: { select: { id: true, name: true, slug: true } } },
          orderBy: { createdAt: "asc" },
        },
      },
    }),
    prisma.department.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
    prisma.businessUnit.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">User Management</h1>
        <p className="text-muted-foreground mt-1">
          Manage user roles and permissions
        </p>
      </div>
      <UserManagement
        users={users as any}
        departments={departments}
        businessUnits={businessUnits}
        currentUserId={session.user.id}
      />
    </div>
  );
}
