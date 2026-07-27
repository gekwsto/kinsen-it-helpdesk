import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { hasPermission } from "@/lib/permissions";
import { getActiveWorkspace } from "@/lib/services/workspace-service";
import { getNavVisibilityFlags } from "@/lib/services/department-scope-service";
import { ActiveWorkspaceProvider } from "@/components/workspace/active-workspace-provider";
import { Sidebar } from "@/components/layout/sidebar";
import { Topbar } from "@/components/layout/topbar";
import { HelpGuideProvider } from "@/components/help/help-guide-provider";
import { HelpGuideWidget } from "@/components/help/help-guide-widget";

export default async function MainLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();

  if (!session?.user) {
    redirect("/login");
  }

  // `image` is deliberately never carried in the session/JWT (base64 photo
  // data would bloat the cookie — see lib/auth.ts's jwt callback) — read
  // fresh here instead, same single-column-by-id pattern already used by
  // Settings/Users-admin/assigned-avatar rendering. Cheap: one indexed PK
  // lookup, one column, run alongside the other per-navigation queries below.
  const [canCreateTicket, activeWorkspace, navFlags, avatarUser] = await Promise.all([
    hasPermission(session.user.role, "ticket.create", session.user.customRoleId),
    getActiveWorkspace(session.user.id, session.user.role),
    getNavVisibilityFlags(session.user.id, session.user.role, session.user.customRoleId),
    prisma.user.findUnique({ where: { id: session.user.id }, select: { image: true } }),
  ]);

  return (
    <ActiveWorkspaceProvider
      initialDepartmentId={activeWorkspace.departmentId}
      departments={activeWorkspace.departments}
      isSystemAdmin={activeWorkspace.isSystemAdmin}
      canViewAllDepartments={activeWorkspace.canViewAllDepartments}
      initialIsAllSelected={activeWorkspace.isAllSelected}
    >
      <HelpGuideProvider>
        <div className="flex h-screen overflow-hidden bg-background">
          <Sidebar userRole={session.user.role} canCreateTicket={canCreateTicket} navFlags={navFlags} />
          <div className="flex-1 flex flex-col overflow-hidden">
            <Topbar user={{ ...session.user, image: avatarUser?.image ?? null }} />
            <main className="flex-1 overflow-y-auto p-6">{children}</main>
          </div>
        </div>
        <HelpGuideWidget />
      </HelpGuideProvider>
    </ActiveWorkspaceProvider>
  );
}
