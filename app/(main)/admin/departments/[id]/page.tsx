import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requireDepartmentPermission, isAdmin } from "@/lib/permissions";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { ChevronRight, Users, Tag } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { DepartmentSettingsForm } from "@/components/admin/department-settings-form";

export default async function DepartmentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) redirect("/login");

  try {
    await requireDepartmentPermission(id, "department.manageSettings");
  } catch {
    redirect("/dashboard");
  }

  const department = await prisma.department.findUnique({
    where: { id },
    include: {
      businessUnit: { select: { id: true, name: true } },
      _count: { select: { users: true, memberships: true, tickets: true, projects: true, categories: true } },
    },
  });
  if (!department) notFound();

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <Link href="/admin/departments" className="hover:text-foreground transition-colors">
          Departments
        </Link>
        <ChevronRight className="h-4 w-4" />
        <span className="text-foreground font-medium">{department.name}</span>
      </div>

      <div>
        <h1 className="text-2xl font-bold">{department.name}</h1>
        <p className="text-muted-foreground mt-1">
          {department._count.users} users · {department._count.projects} projects · {department._count.tickets} tickets
        </p>
      </div>

      <DepartmentSettingsForm
        department={{
          id: department.id,
          name: department.name,
          slug: department.slug,
          description: department.description,
          isActive: department.isActive,
        }}
        canToggleActive={isAdmin(session.user.role)}
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <Link href={`/admin/departments/${department.id}/members`}>
          <Card className="hover:shadow-md transition-shadow cursor-pointer h-full">
            <CardHeader className="flex flex-row items-center gap-3 pb-2">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-50">
                <Users className="h-4 w-4 text-blue-600" />
              </div>
              <div>
                <CardTitle className="text-base">Members</CardTitle>
                <CardDescription>{department._count.memberships} membership{department._count.memberships !== 1 ? "s" : ""}</CardDescription>
              </div>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">Assign users, change roles, revoke access.</p>
            </CardContent>
          </Card>
        </Link>

        <Link href={`/admin/departments/${department.id}/categories`}>
          <Card className="hover:shadow-md transition-shadow cursor-pointer h-full">
            <CardHeader className="flex flex-row items-center gap-3 pb-2">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-50">
                <Tag className="h-4 w-4 text-blue-600" />
              </div>
              <div>
                <CardTitle className="text-base">Categories</CardTitle>
                <CardDescription>{department._count.categories} categor{department._count.categories !== 1 ? "ies" : "y"}</CardDescription>
              </div>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">Manage ticket categories for this department.</p>
            </CardContent>
          </Card>
        </Link>
      </div>
    </div>
  );
}
