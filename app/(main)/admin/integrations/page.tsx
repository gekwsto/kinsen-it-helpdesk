import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { hasPermission } from "@/lib/permissions";
import { IntegrationManagement } from "@/components/admin/integration-management";
import { Plug } from "lucide-react";

export default async function IntegrationsAdminPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const allowed = await hasPermission(session.user.role, "integration.manage", session.user.customRoleId);
  if (!allowed) redirect("/dashboard");

  const [integrations, departments] = await Promise.all([
    prisma.externalIntegration.findMany({
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        slug: true,
        isActive: true,
        departmentId: true,
        department: { select: { id: true, name: true } },
        defaultCategoryId: true,
        defaultCategory: { select: { id: true, name: true } },
        defaultPriorityId: true,
        defaultPriority: { select: { id: true, name: true } },
        baseUrl: true,
        apiKeyPrefix: true,
        lastUsedAt: true,
        createdBy: { select: { id: true, name: true, email: true } },
        createdAt: true,
        _count: { select: { tickets: true } },
      },
    }),
    prisma.department.findMany({
      where: { isActive: true },
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        categories: {
          where: { isActive: true },
          orderBy: { name: "asc" },
          select: { id: true, name: true },
        },
        priorities: {
          where: { isActive: true },
          orderBy: { level: "asc" },
          select: { id: true, name: true },
        },
      },
    }),
  ]);

  return (
    <div className="space-y-8 max-w-6xl">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10">
          <Plug className="h-5 w-5 text-primary" />
        </div>
        <div>
          <h1 className="text-2xl font-bold">External Integrations</h1>
          <p className="text-muted-foreground text-sm mt-0.5">
            API keys that let other applications create real tickets in TicketApp
          </p>
        </div>
      </div>

      <IntegrationManagement integrations={integrations as any} departments={departments as any} />
    </div>
  );
}
