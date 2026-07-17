import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/permissions";
import { getCachedDirectoryDepartmentValues, getCachedDirectoryJobTitleValues } from "@/lib/services/microsoft-directory-service";

export async function GET() {
  try {
    await requireAdmin();
    const [departments, jobTitles] = await Promise.all([
      getCachedDirectoryDepartmentValues(),
      getCachedDirectoryJobTitleValues(),
    ]);
    return NextResponse.json({
      departments,
      jobTitles,
      ready: {
        graphTenantConfigured: !!process.env.GRAPH_TENANT_ID,
        graphClientConfigured: !!process.env.GRAPH_CLIENT_ID,
        graphSecretConfigured: !!process.env.GRAPH_CLIENT_SECRET,
      },
    });
  } catch (error: any) {
    if (error.message === "Unauthorized") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
}
