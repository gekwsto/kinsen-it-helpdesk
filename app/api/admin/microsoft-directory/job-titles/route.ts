import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/permissions";
import { listJobTitleDirectoryForAdmin } from "@/lib/services/microsoft-job-title-directory-service";

export async function GET() {
  try {
    await requireAdmin();
    const { domain, rows } = await listJobTitleDirectoryForAdmin();
    return NextResponse.json({ domain, rows });
  } catch (error: any) {
    if (error.message === "Unauthorized") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
}
