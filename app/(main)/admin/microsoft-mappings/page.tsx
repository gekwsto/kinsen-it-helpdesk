import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { listMappings } from "@/lib/services/microsoft-mapping-service";
import { listDepartments } from "@/lib/services/department-service";
import { getCachedDirectoryDepartmentValues, getCachedDirectoryJobTitleValues } from "@/lib/services/microsoft-directory-service";
import { listJobTitleDirectoryForAdmin } from "@/lib/services/microsoft-job-title-directory-service";
import {
  getMicrosoftMappingGlobalRoleOptions,
  getMicrosoftMappingDepartmentRoleOptions,
} from "@/lib/services/microsoft-mapping-role-options-service";
import { MicrosoftMappingManagement } from "@/components/admin/microsoft-mapping-management";
import { ALLOWED_ORGANIZATION_EMAIL_DOMAINS } from "@/lib/allowed-email-domains";

export default async function MicrosoftMappingsAdminPage() {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") redirect("/dashboard");

  const [mappings, departments, departmentDirectory, jobTitleDirectory, jobTitleDirectoryDiscovery, globalRoleOptions, departmentRoleOptions] =
    await Promise.all([
      listMappings(),
      listDepartments(),
      getCachedDirectoryDepartmentValues(),
      getCachedDirectoryJobTitleValues(),
      listJobTitleDirectoryForAdmin(),
      getMicrosoftMappingGlobalRoleOptions(),
      getMicrosoftMappingDepartmentRoleOptions(),
    ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Microsoft Mappings</h1>
        <p className="text-muted-foreground mt-1">
          Data-driven rules that turn a Microsoft profile department, profile job title, Entra group, or app role
          into department access on login — no code changes needed to add more.
        </p>
      </div>
      <MicrosoftMappingManagement
        mappings={mappings as any}
        departments={departments}
        departmentDirectory={{
          values: departmentDirectory.values,
          lastSyncedAt: departmentDirectory.lastSyncedAt ? departmentDirectory.lastSyncedAt.toISOString() : null,
        }}
        jobTitleDirectory={{
          values: jobTitleDirectory.values,
          lastSyncedAt: jobTitleDirectory.lastSyncedAt ? jobTitleDirectory.lastSyncedAt.toISOString() : null,
        }}
        jobTitleDiscoveryDomain={jobTitleDirectoryDiscovery.domain}
        allowedDomains={[...ALLOWED_ORGANIZATION_EMAIL_DOMAINS]}
        jobTitleDiscoveryRows={jobTitleDirectoryDiscovery.rows.map((r) => ({
          ...r,
          firstSeenAt: r.firstSeenAt.toISOString(),
          lastSeenAt: r.lastSeenAt.toISOString(),
        }))}
        initialGlobalRoleOptions={globalRoleOptions}
        initialDepartmentRoleOptions={departmentRoleOptions}
      />
    </div>
  );
}
