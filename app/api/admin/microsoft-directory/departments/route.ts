import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/permissions";
import { getCachedDirectoryDepartmentValues } from "@/lib/services/microsoft-directory-service";

export async function GET() {
  try {
    await requireAdmin();
    const data = await getCachedDirectoryDepartmentValues();
    return NextResponse.json(data);
  } catch (error: any) {
    if (error.message === "Unauthorized") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
}
