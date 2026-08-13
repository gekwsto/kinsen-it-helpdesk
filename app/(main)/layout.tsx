import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getActiveWorkspace } from "@/lib/services/workspace-service";
import { getNavVisibilityFlags } from "@/lib/services/department-scope-service";
import { ActiveWorkspaceProvider } from "@/components/workspace/active-workspace-provider";
import { AppRoutePrefetcher } from "@/components/navigation/app-route-prefetcher";
import { Sidebar } from "@/components/layout/sidebar";
import { Topbar } from "@/components/layout/topbar";
import { HelpGuideProvider } from "@/components/help/help-guide-provider";
import { HelpGuideWidget } from "@/components/help/help-guide-widget";
import { SessionExpiryController } from "@/components/auth/session-expiry-controller";

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
  // customRole.name is fetched the same way — session only carries
  // customRoleId (see lib/auth.ts), never the resolved persisted name, and
  // the Topbar's role badge must prefer that name over a static label (see
  // lib/services/global-role-options-service.ts's doc comment).
  const [activeWorkspace, navFlags, avatarUser] = await Promise.all([
    getActiveWorkspace(session.user.id, session.user.role),
    getNavVisibilityFlags(session.user.id, session.user.role, session.user.customRoleId),
    prisma.user.findUnique({ where: { id: session.user.id }, select: { image: true, customRole: { select: { name: true } } } }),
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
          <Sidebar userRole={session.user.role} navFlags={navFlags} />
          <div className="flex-1 flex flex-col overflow-hidden">
            <Topbar user={{ ...session.user, image: avatarUser?.image ?? null, roleName: avatarUser?.customRole?.name ?? null }} />
            <main className="flex-1 overflow-y-auto p-6">{children}</main>
          </div>
        </div>
        <HelpGuideWidget />
      </HelpGuideProvider>
      {/* Central, single mount point for absolute-8h session enforcement —
          never one per page. See components/auth/session-expiry-controller.tsx. */}
      <SessionExpiryController />
      {/* Central, single mount point for background route warming — never a
          per-page useEffect fetch. Must live inside ActiveWorkspaceProvider
          (it reads useActiveWorkspace() to re-warm on workspace switches).
          See components/navigation/app-route-prefetcher.tsx. */}
      <AppRoutePrefetcher userRole={session.user.role} navFlags={navFlags} />
    </ActiveWorkspaceProvider>
  );
}
