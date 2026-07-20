import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { getActiveWorkspace } from "@/lib/services/workspace-service";
import { ActivityNewForm } from "@/components/activities/activity-new-form";

export default async function NewActivityPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const activeWorkspace = await getActiveWorkspace(session.user.id, session.user.role);

  return <ActivityNewForm departmentId={activeWorkspace.isAllSelected ? null : activeWorkspace.departmentId} />;
}
