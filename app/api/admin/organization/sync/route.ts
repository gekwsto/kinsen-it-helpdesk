import { NextResponse } from "next/server";
import { OrganizationSyncType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/permissions";
import { canTriggerOrganizationSync } from "@/lib/services/organization-scope-service";
import { runOrganizationSync } from "@/lib/services/organization-sync-orchestrator";
import { describeOrganizationSyncFailure } from "@/lib/services/organization-sync-error-messages";
import { apiError, unauthorizedResponse, forbiddenResponse, internalErrorResponse } from "@/lib/api-errors";

// POST /api/admin/organization/sync — full tenant directory scan + manager
// sync. Admin-only by default (organization.sync permission — see
// prisma/seed.ts); ADMIN bypasses via hasPermission() unconditionally.
export async function POST() {
  try {
    const session = await requireAuth();
    const allowed = await canTriggerOrganizationSync(session.user.role, session.user.customRoleId);
    if (!allowed) return forbiddenResponse("You do not have permission to sync the organization.");

    const result = await runOrganizationSync(OrganizationSyncType.FULL, session.user.id);

    if (result.alreadyRunning) {
      return NextResponse.json(apiError("sync_already_running", "Another organization sync is already running. Wait for it to finish before starting a new one."), { status: 409 });
    }
    if (result.status === "FAILED") {
      const run = await prisma.organizationSyncRun.findUnique({ where: { id: result.runId } });
      const { code, message } = describeOrganizationSyncFailure(run?.lastError ?? null);
      return NextResponse.json(apiError(code, message), { status: 502 });
    }

    return NextResponse.json(result);
  } catch (error: any) {
    if (error.message === "Unauthorized") return unauthorizedResponse();
    console.error("[api/admin/organization/sync] failed", error);
    return internalErrorResponse();
  }
}
