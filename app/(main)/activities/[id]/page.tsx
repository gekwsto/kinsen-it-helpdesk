import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { hasPermission } from "@/lib/permissions";
import { ActivityDetailClient } from "./activity-detail-client";

export default async function ActivityDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) redirect("/login");

  // GLOBAL-only permission (no departmentId on a dependency — see
  // ActivityDependency in prisma/schema.prisma) — delegable to a custom
  // role now, not hardcoded to Role.ADMIN; see app/api/dependencies/route.ts.
  const canManageDependencies = await hasPermission(session.user.role, "activity.dependency.manage", session.user.customRoleId);
  return <ActivityDetailClient id={id} canManageDependencies={canManageDependencies} />;
}
