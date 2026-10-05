import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, hasPermission } from "@/lib/permissions";
import { projectRequestTypeSchema } from "@/lib/validations";
import { apiError, zodErrorResponse, unauthorizedResponse, forbiddenResponse, internalErrorResponse } from "@/lib/api-errors";

// Project Request Types are a single GLOBAL reference list (no department
// scope at all — every department's requesters share the same dropdown),
// structurally the same shape as Company/BusinessUnit. Gated by the
// existing `admin.access` permission (not a new bespoke
// projectRequestType.* trio) per the task's own "reuse an existing settings
// permission" instruction — admin.access is currently held ONLY by ADMIN
// (via its blanket bootstrap grant; no other role lists it in
// prisma/seed.ts), so this is real RBAC, not a hardcoded role check, while
// behaving identically to admin-only today.
async function requireSettingsAccess() {
  const session = await requireAuth();
  const allowed = await hasPermission(session.user.role, "admin.access", session.user.customRoleId);
  if (!allowed) throw new Error("Forbidden");
  return session;
}

// GET — every type, active and inactive (an admin visibility view, not the
// form's own active-only dropdown — see /api/project-request-types).
export async function GET() {
  try {
    await requireSettingsAccess();
    const types = await prisma.projectRequestType.findMany({
      orderBy: { createdAt: "asc" },
      include: { _count: { select: { projectRequests: true } } },
    });
    return NextResponse.json(types);
  } catch (error: any) {
    if (error.message === "Unauthorized") return unauthorizedResponse();
    if (error.message === "Forbidden") return forbiddenResponse("You do not have permission to manage Project Request Types.");
    console.error("[api/admin/project-request-types] GET failed", error);
    return internalErrorResponse();
  }
}

export async function POST(req: NextRequest) {
  try {
    await requireSettingsAccess();
    const body = await req.json();
    const parsed = projectRequestTypeSchema.safeParse(body);
    if (!parsed.success) return zodErrorResponse(parsed.error);

    const existing = await prisma.projectRequestType.findUnique({ where: { name: parsed.data.name }, select: { id: true } });
    if (existing) {
      return NextResponse.json(apiError("name_taken", "A Project Request Type with this name already exists.", { field: "name" }), { status: 409 });
    }

    const type = await prisma.projectRequestType.create({
      data: { name: parsed.data.name, isActive: parsed.data.isActive ?? true },
    });
    return NextResponse.json({ ...type, _count: { projectRequests: 0 } }, { status: 201 });
  } catch (error: any) {
    if (error.message === "Unauthorized") return unauthorizedResponse();
    if (error.message === "Forbidden") return forbiddenResponse("You do not have permission to manage Project Request Types.");
    console.error("[api/admin/project-request-types] POST failed", error);
    return internalErrorResponse();
  }
}
