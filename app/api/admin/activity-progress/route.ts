import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAnyDepartmentPermission, requireDepartmentPermission } from "@/lib/permissions";
import { getDepartmentProgressRows, countActivitiesUsingStatus } from "@/lib/activities/activity-progress";
import { logDepartmentConfigHealth } from "@/lib/services/config-health";
import { apiError, unauthorizedResponse, forbiddenResponse, internalErrorResponse } from "@/lib/api-errors";
import { ActivityStatus } from "@prisma/client";

const ACTIVITY_PROGRESS_PERMISSION_KEYS = ["activityProgress.create", "activityProgress.edit", "activityProgress.delete"];

function isValidPercent(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100;
}

// GET /api/admin/activity-progress?departmentId=X -> that department's real
// rows only (may be fewer than 6 after a delete), sorted by sortOrder —
// System Admin or anyone holding an activityProgress.* permission in X.
export async function GET(req: NextRequest) {
  try {
    const departmentId = req.nextUrl.searchParams.get("departmentId");
    if (!departmentId) {
      return NextResponse.json(apiError("department_required", "departmentId is required", { field: "departmentId" }), { status: 400 });
    }
    await requireAnyDepartmentPermission(departmentId, ACTIVITY_PROGRESS_PERMISSION_KEYS);

    const rows = await getDepartmentProgressRows(departmentId);
    return NextResponse.json({ departmentId, rows });
  } catch (error: any) {
    if (error.message === "Unauthorized") return unauthorizedResponse();
    return forbiddenResponse();
  }
}

// PUT /api/admin/activity-progress -> bulk save (percent/isEnabled/sortOrder)
// for this department's EXISTING rows, one transaction. Never creates a
// row that doesn't already exist (use POST for that) and never touches
// another department's rows — every row's own (departmentId, status) is
// re-verified against the authenticated, permission-checked departmentId.
//
// Usage-analysis guard: a row transitioning isEnabled true -> false is
// blocked outright (409 item_in_use) when any activity in this department
// currently has that status — disabling would otherwise silently strand
// those activities without progress semantics (they'd start resolving to
// the fail-safe "Configuration required" state instead of a real
// percentage). The WHOLE request is rejected atomically if any row fails
// this check — never a partial save that silently disables the ones that
// were safe while dropping the blocked one.
export async function PUT(req: NextRequest) {
  try {
    const { departmentId, rows } = await req.json();
    if (!departmentId || !Array.isArray(rows)) {
      return NextResponse.json(apiError("invalid_payload", "departmentId and rows are required"), { status: 400 });
    }
    try {
      await requireDepartmentPermission(departmentId, "activityProgress.edit");
    } catch (error: any) {
      if (error.message === "Unauthorized") return unauthorizedResponse();
      return forbiddenResponse("You do not have permission to edit activity progress in this department.");
    }

    const validStatuses = Object.values(ActivityStatus) as string[];
    const seenStatuses = new Set<string>();
    for (const row of rows) {
      if (!validStatuses.includes(row?.status)) {
        return NextResponse.json(apiError("invalid_status", `Unknown status: ${row?.status}`, { field: "status" }), { status: 400 });
      }
      if (seenStatuses.has(row.status)) {
        return NextResponse.json(apiError("duplicate_status", `Duplicate status in request: ${row.status}`, { field: "status" }), { status: 400 });
      }
      seenStatuses.add(row.status);
      if (!isValidPercent(row.progressPercent)) {
        return NextResponse.json(apiError("invalid_percentage", `${row.status} progress must be an integer between 0 and 100`, { field: "progressPercent" }), { status: 400 });
      }
      if (typeof row.isEnabled !== "boolean") {
        return NextResponse.json(apiError("invalid_payload", `${row.status} isEnabled must be a boolean`, { field: "isEnabled" }), { status: 400 });
      }
      if (!Number.isInteger(row.sortOrder)) {
        return NextResponse.json(apiError("invalid_payload", `${row.status} sortOrder must be an integer`, { field: "sortOrder" }), { status: 400 });
      }
    }

    const currentRows = await prisma.activityProgressConfig.findMany({
      where: { departmentId, status: { in: rows.map((r: { status: ActivityStatus }) => r.status) } },
      select: { status: true, isEnabled: true },
    });
    const currentByStatus = new Map(currentRows.map((r) => [r.status, r.isEnabled]));

    for (const row of rows as Array<{ status: ActivityStatus; isEnabled: boolean }>) {
      const wasEnabled = currentByStatus.get(row.status);
      const isDisabling = wasEnabled === true && row.isEnabled === false;
      if (isDisabling) {
        const usageCount = await countActivitiesUsingStatus(departmentId, row.status);
        if (usageCount > 0) {
          return NextResponse.json(
            apiError(
              "item_in_use",
              `Cannot disable "${row.status}" — ${usageCount} activit${usageCount === 1 ? "y" : "ies"} in this department currently ${usageCount === 1 ? "has" : "have"} this status and would lose their progress percentage. Move or update those activities first.`,
              { field: "isEnabled" }
            ),
            { status: 409 }
          );
        }
      }
    }

    // Only updates rows that already exist for this department (POST
    // creates new ones) — an update targeting a (departmentId, status)
    // pair with no existing row is silently a no-op count-wise under
    // updateMany, which is the correct, safe behavior here (never
    // resurrects a deliberately-deleted row via a stale client payload).
    await prisma.$transaction(
      rows.map((row: { status: ActivityStatus; progressPercent: number; isEnabled: boolean; sortOrder: number }) =>
        prisma.activityProgressConfig.updateMany({
          where: { departmentId, status: row.status },
          data: { progressPercent: row.progressPercent, isEnabled: row.isEnabled, sortOrder: row.sortOrder },
        })
      )
    );

    const updatedRows = await getDepartmentProgressRows(departmentId);
    await logDepartmentConfigHealth(prisma, departmentId, "activity-progress PUT");
    return NextResponse.json({ departmentId, rows: updatedRows });
  } catch {
    return internalErrorResponse();
  }
}

// POST /api/admin/activity-progress -> creates (or "adds back") one status
// row for a department that doesn't currently have one — the create half
// of full CRUD (rows aren't invented out of nowhere; ActivityStatus is a
// fixed enum, so "create" always means "this department didn't have a row
// for this real status yet").
export async function POST(req: NextRequest) {
  try {
    const { departmentId, status, progressPercent, sortOrder } = await req.json();
    if (!departmentId || !status) {
      return NextResponse.json(apiError("invalid_payload", "departmentId and status are required"), { status: 400 });
    }
    if (!(Object.values(ActivityStatus) as string[]).includes(status)) {
      return NextResponse.json(apiError("invalid_status", `Unknown status: ${status}`, { field: "status" }), { status: 400 });
    }
    if (!isValidPercent(progressPercent)) {
      return NextResponse.json(apiError("invalid_percentage", "progressPercent must be an integer between 0 and 100", { field: "progressPercent" }), { status: 400 });
    }

    try {
      await requireDepartmentPermission(departmentId, "activityProgress.create");
    } catch (error: any) {
      if (error.message === "Unauthorized") return unauthorizedResponse();
      return forbiddenResponse("You do not have permission to create activity progress rows in this department.");
    }

    const department = await prisma.department.findUnique({ where: { id: departmentId }, select: { id: true } });
    if (!department) {
      return NextResponse.json(apiError("invalid_department", "The selected department does not exist.", { field: "departmentId" }), { status: 400 });
    }

    const existing = await prisma.activityProgressConfig.findUnique({ where: { departmentId_status: { departmentId, status } } });
    if (existing) {
      return NextResponse.json(apiError("duplicate_status", `${status} already has a configuration row for this department.`, { field: "status" }), { status: 409 });
    }

    const created = await prisma.activityProgressConfig.create({
      data: { departmentId, status, progressPercent, isEnabled: true, sortOrder: Number.isInteger(sortOrder) ? sortOrder : 0 },
    });
    await logDepartmentConfigHealth(prisma, departmentId, "activity-progress POST");
    return NextResponse.json(created, { status: 201 });
  } catch (error: any) {
    if (error.code === "P2002") {
      return NextResponse.json(apiError("duplicate_status", "This status already has a configuration row for this department.", { field: "status" }), { status: 409 });
    }
    if (error.code === "P2003") {
      return NextResponse.json(apiError("invalid_department", "The selected department does not exist.", { field: "departmentId" }), { status: 400 });
    }
    return internalErrorResponse();
  }
}

// DELETE /api/admin/activity-progress?departmentId=X&status=Y -> removes
// that department's row for that status entirely (reverts to the logged
// configuration-gap fail-safe — see lib/activities/activity-progress.ts —
// until re-added). No FK/reference safety check is needed at the DB level:
// unlike SLA/TicketPriority, no other table references an
// ActivityProgressConfig row via a foreign key, so this can never orphan a
// row — but a usage-analysis check is still required (business-level
// safety, not FK safety): deleting a status any existing activity in this
// department currently has would silently strand those activities without
// progress semantics, so that is blocked here exactly like the PUT
// disable-transition guard above.
export async function DELETE(req: NextRequest) {
  try {
    const departmentId = req.nextUrl.searchParams.get("departmentId");
    const status = req.nextUrl.searchParams.get("status");
    if (!departmentId || !status) {
      return NextResponse.json(apiError("invalid_payload", "departmentId and status are required"), { status: 400 });
    }
    if (!(Object.values(ActivityStatus) as string[]).includes(status)) {
      return NextResponse.json(apiError("invalid_status", `Unknown status: ${status}`, { field: "status" }), { status: 400 });
    }

    try {
      await requireDepartmentPermission(departmentId, "activityProgress.delete");
    } catch (error: any) {
      if (error.message === "Unauthorized") return unauthorizedResponse();
      return forbiddenResponse("You do not have permission to delete activity progress rows in this department.");
    }

    const existing = await prisma.activityProgressConfig.findUnique({
      where: { departmentId_status: { departmentId, status: status as ActivityStatus } },
    });
    if (!existing) {
      return NextResponse.json(apiError("item_not_found", "No configuration row found for that department/status."), { status: 404 });
    }

    const usageCount = await countActivitiesUsingStatus(departmentId, status as ActivityStatus);
    if (usageCount > 0) {
      return NextResponse.json(
        apiError(
          "item_in_use",
          `Cannot delete "${status}" — ${usageCount} activit${usageCount === 1 ? "y" : "ies"} in this department currently ${usageCount === 1 ? "has" : "have"} this status and would lose their progress percentage. Move or update those activities first, or disable the status instead once it is unused — disabling is also blocked while any activity still uses it.`
        ),
        { status: 409 }
      );
    }

    await prisma.activityProgressConfig.delete({ where: { departmentId_status: { departmentId, status: status as ActivityStatus } } });
    await logDepartmentConfigHealth(prisma, departmentId, "activity-progress DELETE");
    return new NextResponse(null, { status: 204 });
  } catch {
    return internalErrorResponse();
  }
}
