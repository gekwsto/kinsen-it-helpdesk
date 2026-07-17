import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { listMappings } from "@/lib/services/microsoft-mapping-service";
import { listDepartments } from "@/lib/services/department-service";
import { getCachedDirectoryDepartmentValues } from "@/lib/services/microsoft-directory-service";
import { MicrosoftMappingManagement } from "@/components/admin/microsoft-mapping-management";

export default async function MicrosoftMappingsAdminPage() {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") redirect("/dashboard");

  const [mappings, departments, directory] = await Promise.all([
    listMappings(),
    listDepartments(),
    getCachedDirectoryDepartmentValues(),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Microsoft Mappings</h1>
        <p className="text-muted-foreground mt-1">
          Data-driven rules that turn a Microsoft profile department, Entra group, or app role into department
          access on login — no code changes needed to add more.
        </p>
      </div>
      <MicrosoftMappingManagement
        mappings={mappings as any}
        departments={departments}
        directoryValues={directory.values}
        directoryLastSyncedAt={directory.lastSyncedAt ? directory.lastSyncedAt.toISOString() : null}
      />
    </div>
  );
}
