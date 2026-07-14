import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { getActiveWorkspace } from "@/lib/services/workspace-service";
import { ActiveWorkspaceProvider } from "@/components/workspace/active-workspace-provider";
import { Sidebar } from "@/components/layout/sidebar";
import { Topbar } from "@/components/layout/topbar";
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

  const [canCreateTicket, activeWorkspace] = await Promise.all([
    hasPermission(session.user.role, "ticket.create", session.user.customRoleId),
    getActiveWorkspace(session.user.id, session.user.role),
  ]);

  return (
    <ActiveWorkspaceProvider
      initialDepartmentId={activeWorkspace.departmentId}
      departments={activeWorkspace.departments}
      isSystemAdmin={activeWorkspace.isSystemAdmin}
    >
      <div className="flex h-screen overflow-hidden bg-background">
        <Sidebar userRole={session.user.role} canCreateTicket={canCreateTicket} />
        <div className="flex-1 flex flex-col overflow-hidden">
          <Topbar user={session.user} />
          <main className="flex-1 overflow-y-auto p-6">{children}</main>
        </div>
      </div>
      <HelpGuideWidget />
    </ActiveWorkspaceProvider>
  );
}
