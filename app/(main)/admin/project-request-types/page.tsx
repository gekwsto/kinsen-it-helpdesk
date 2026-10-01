import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { hasPermission } from "@/lib/permissions";
import { ProjectRequestTypeManagement } from "@/components/admin/project-request-type-management";

export default async function ProjectRequestTypesAdminPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const allowed = await hasPermission(session.user.role, "admin.access", session.user.customRoleId);
  if (!allowed) redirect("/dashboard");

  const types = await prisma.projectRequestType.findMany({
    orderBy: { createdAt: "asc" },
    include: { _count: { select: { projectRequests: true } } },
  });
  // Prisma.Decimal is a class instance, not a plain serializable value — it
  // cannot cross the Server -> Client Component boundary as-is (React
  // Server Components only support plain objects/primitives/Date/etc.).
  // Converted to a plain `number | null` here, once, before handing off to
  // the client component below.
  const typesForClient = types.map((t) => ({ ...t, cost: t.cost ? Number(t.cost) : null }));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Project Request Types</h1>
        <p className="text-muted-foreground mt-1">
          Manage the Project Type options offered on the Project Request Form.
        </p>
      </div>
      <ProjectRequestTypeManagement types={typesForClient} />
    </div>
  );
}
