import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAnyDepartmentPermission, requireDepartmentPermission } from "@/lib/permissions";
import { getDepartmentActivityStatusRows } from "@/lib/services/activity-status-config";
import { countActivitiesUsingStatus } from "@/lib/activities/activity-progress";
import { logDepartmentConfigHealth } from "@/lib/services/config-health";
import { apiError, unauthorizedResponse, forbiddenResponse, internalErrorResponse } from "@/lib/api-errors";
import { ActivityStatus } from "@prisma/client";

const ACTIVITY_STATUS_PERMISSION_KEYS = ["activityProgress.create", "activityProgress.edit", "activityProgress.delete"];
const COLOR_REGEX = /^#[0-9A-Fa-f]{6}$/;

// Reuses the exact same activityProgress.* permission keys as
// /api/admin/activity-progress — both screens manage the same
// department-scoped "how an Activity Status behaves" surface (percentage
// vs. display metadata), so a role granted one already reasonably expects
// the other; introducing a brand-new permission key for this would be a
// parallel, redundant permission system for the same underlying concept.

function isValidRow(row: any): row is { status: ActivityStatus; label: string; color: string; sortOrder: number; isEnabled: boolean; isTerminal: boolean } {
  return (
    row &&
    (Object.values(ActivityStatus) as string[]).includes(row.status) &&
    typeof row.label === "string" &&
    row.label.trim().length > 0 &&
    typeof row.color === "string" &&
    COLOR_REGEX.test(row.color) &&
    Number.isInteger(row.sortOrder) &&
    typeof row.isEnabled === "boolean" &&
    typeof row.isTerminal === "boolean"
  );
}

// GET /api/admin/activity-statuses?departmentId=X -> that department's real
// rows only, sorted by sortOrder — System Admin or anyone holding an
// activityProgress.* permission in X.
export async function GET(req: NextRequest) {
  try {
    const departmentId = req.nextUrl.searchParams.get("departmentId");
    if (!departmentId) {
      return NextResponse.json(apiError("department_required", "departmentId is required", { field: "departmentId" }), { status: 400 });
    }
    await requireAnyDepartmentPermission(departmentId, ACTIVITY_STATUS_PERMISSION_KEYS);

    const rows = await getDepartmentActivityStatusRows(departmentId);
    return NextResponse.json({ departmentId, rows });
  } catch (error: any) {
    if (error.message === "Unauthorized") return unauthorizedResponse();
    return forbiddenResponse();
  }
}

// PATCH /api/admin/activity-statuses -> bulk save (label/color/sortOrder/
// isEnabled/isTerminal) for this department's EXISTING rows, one
// transaction. Never touches another department's rows — every row's own
// (departmentId, status) is re-verified against the authenticated,
// permission-checked departmentId, exactly like PUT /api/admin/activity-progress.
//
// Usage-analysis guard: disabling a status any activity in this department
// currently has is blocked (409 item_in_use) — a disabled status must never
// silently strand real activities without a selectable status. The WHOLE
// request is rejected atomically if any row fails this check.
export async function PATCH(req: NextRequest) {
  try {
    const { departmentId, rows } = await req.json();
    if (!departmentId || !Array.isArray(rows)) {
      return NextResponse.json(apiError("invalid_payload", "departmentId and rows are required"), { status: 400 });
    }
    try {
      await requireDepartmentPermission(departmentId, "activityProgress.edit");
    } catch (error: any) {
      if (error.message === "Unauthorized") return unauthorizedResponse();
      return forbiddenResponse("You do not have permission to edit activity statuses in this department.");
    }

    const seenStatuses = new Set<string>();
    for (const row of rows) {
      if (!isValidRow(row)) {
        return NextResponse.json(
          apiError("invalid_payload", `Each row needs a valid status, a non-empty label, a valid #RRGGBB color, an integer sortOrder, and boolean isEnabled/isTerminal.${row?.status ? ` (status: ${row.status})` : ""}`),
          { status: 400 }
        );
      }
      if (seenStatuses.has(row.status)) {
        return NextResponse.json(apiError("duplicate_status", `Duplicate status in request: ${row.status}`, { field: "status" }), { status: 400 });
      }
      seenStatuses.add(row.status);
    }

    const currentRows = await prisma.activityStatusConfig.findMany({
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
              `Cannot disable "${row.status}" — ${usageCount} activit${usageCount === 1 ? "y" : "ies"} in this department currently ${usageCount === 1 ? "has" : "have"} this status. Move or update those activities first.`,
              { field: "isEnabled" }
            ),
            { status: 409 }
          );
        }
      }
    }

    await prisma.$transaction(
      rows.map((row: { status: ActivityStatus; label: string; color: string; sortOrder: number; isEnabled: boolean; isTerminal: boolean }) =>
        prisma.activityStatusConfig.updateMany({
          where: { departmentId, status: row.status },
          data: { label: row.label.trim(), color: row.color, sortOrder: row.sortOrder, isEnabled: row.isEnabled, isTerminal: row.isTerminal },
        })
      )
    );

    const updatedRows = await getDepartmentActivityStatusRows(departmentId);
    await logDepartmentConfigHealth(prisma, departmentId, "activity-statuses PATCH");
    return NextResponse.json({ departmentId, rows: updatedRows });
  } catch {
    return internalErrorResponse();
  }
}

// POST /api/admin/activity-statuses -> re-adds one status row a department
// doesn't currently have (mirrors POST /api/admin/activity-progress — rows
// aren't invented, ActivityStatus is a fixed enum, so "create" always means
// "this department didn't have a row for this real status yet", e.g. after
// a prior delete).
export async function POST(req: NextRequest) {
  try {
    const { departmentId, status, label, color, sortOrder } = await req.json();
    if (!departmentId || !status) {
      return NextResponse.json(apiError("invalid_payload", "departmentId and status are required"), { status: 400 });
    }
    if (!(Object.values(ActivityStatus) as string[]).includes(status)) {
      return NextResponse.json(apiError("invalid_status", `Unknown status: ${status}`, { field: "status" }), { status: 400 });
    }
    if (typeof label !== "string" || !label.trim()) {
      return NextResponse.json(apiError("invalid_label", "A label is required.", { field: "label" }), { status: 400 });
    }
    if (typeof color !== "string" || !COLOR_REGEX.test(color)) {
      return NextResponse.json(apiError("invalid_color", "Color must be a valid #RRGGBB hex value.", { field: "color" }), { status: 400 });
    }

    try {
      await requireDepartmentPermission(departmentId, "activityProgress.create");
    } catch (error: any) {
      if (error.message === "Unauthorized") return unauthorizedResponse();
      return forbiddenResponse("You do not have permission to create activity statuses in this department.");
    }

    const department = await prisma.department.findUnique({ where: { id: departmentId }, select: { id: true } });
    if (!department) {
      return NextResponse.json(apiError("invalid_department", "The selected department does not exist.", { field: "departmentId" }), { status: 400 });
    }

    const existing = await prisma.activityStatusConfig.findUnique({ where: { departmentId_status: { departmentId, status } } });
    if (existing) {
      return NextResponse.json(apiError("duplicate_status", `${status} already has a configuration row for this department.`, { field: "status" }), { status: 409 });
    }

    const created = await prisma.activityStatusConfig.create({
      data: { departmentId, status, label: label.trim(), color, isEnabled: true, isTerminal: false, sortOrder: Number.isInteger(sortOrder) ? sortOrder : 0 },
    });
    await logDepartmentConfigHealth(prisma, departmentId, "activity-statuses POST");
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

// DELETE /api/admin/activity-statuses?departmentId=X&status=Y -> removes
// that department's row for that status entirely (reverts to the logged
// configuration-gap fail-safe — see lib/services/activity-status-config.ts
// — until re-added via POST). Blocked while any activity in this department
// currently has that status — same usage-analysis guard as the PATCH
// disable-transition above and as DELETE /api/admin/activity-progress.
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
      return forbiddenResponse("You do not have permission to delete activity statuses in this department.");
    }

    const existing = await prisma.activityStatusConfig.findUnique({
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
          `Cannot delete "${status}" — ${usageCount} activit${usageCount === 1 ? "y" : "ies"} in this department currently ${usageCount === 1 ? "has" : "have"} this status. Move or update those activities first, or disable the status instead once it is unused.`
        ),
        { status: 409 }
      );
    }

    await prisma.activityStatusConfig.delete({ where: { departmentId_status: { departmentId, status: status as ActivityStatus } } });
    await logDepartmentConfigHealth(prisma, departmentId, "activity-statuses DELETE");
    return new NextResponse(null, { status: 204 });
  } catch {
    return internalErrorResponse();
  }
}
