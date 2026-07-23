import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAnyDepartmentPermission, requireDepartmentPermission } from "@/lib/permissions";
import { getDepartmentProgressConfig } from "@/lib/activities/activity-progress";
import { ActivityStatus } from "@prisma/client";

const ACTIVITY_PROGRESS_PERMISSION_KEYS = ["activityProgress.edit"];

// GET /api/admin/activity-progress?departmentId=X -> that department's 6-status
// mapping — System Admin or anyone holding activityProgress.edit in X.
export async function GET(req: NextRequest) {
  try {
    const departmentId = req.nextUrl.searchParams.get("departmentId");
    if (!departmentId) {
      return NextResponse.json({ error: "departmentId is required", code: "department_required" }, { status: 400 });
    }
    await requireAnyDepartmentPermission(departmentId, ACTIVITY_PROGRESS_PERMISSION_KEYS);

    const config = await getDepartmentProgressConfig(departmentId);
    return NextResponse.json({ departmentId, config });
  } catch (error: any) {
    if (error.message === "Unauthorized") return NextResponse.json({ error: "Unauthorized", code: "unauthorized" }, { status: 401 });
    return NextResponse.json({ error: "Forbidden", code: "missing_permission" }, { status: 403 });
  }
}

// PUT /api/admin/activity-progress -> upserts all 6 percentages for one department in one call.
export async function PUT(req: NextRequest) {
  try {
    const { departmentId, percentages } = await req.json();
    if (!departmentId || typeof percentages !== "object" || percentages === null) {
      return NextResponse.json({ error: "departmentId and percentages are required", code: "invalid_payload" }, { status: 400 });
    }
    await requireDepartmentPermission(departmentId, "activityProgress.edit");

    const validStatuses = Object.values(ActivityStatus);
    for (const [status, value] of Object.entries(percentages)) {
      if (!validStatuses.includes(status as ActivityStatus)) {
        return NextResponse.json({ error: `Unknown status: ${status}`, code: "invalid_status" }, { status: 400 });
      }
      const num = Number(value);
      if (!Number.isInteger(num) || num < 0 || num > 100) {
        return NextResponse.json({ error: `${status} must be an integer between 0 and 100`, code: "invalid_percentage" }, { status: 400 });
      }
    }

    await Promise.all(
      Object.entries(percentages).map(([status, value]) =>
        prisma.activityProgressConfig.upsert({
          where: { departmentId_status: { departmentId, status: status as ActivityStatus } },
          update: { progressPercent: Number(value) },
          create: { departmentId, status: status as ActivityStatus, progressPercent: Number(value) },
        })
      )
    );

    const config = await getDepartmentProgressConfig(departmentId);
    return NextResponse.json({ departmentId, config });
  } catch (error: any) {
    if (error.message === "Unauthorized") return NextResponse.json({ error: "Unauthorized", code: "unauthorized" }, { status: 401 });
    return NextResponse.json({ error: "Forbidden", code: "missing_permission" }, { status: 403 });
  }
}
