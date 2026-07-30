import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, hasPermission } from "@/lib/permissions";
import { updateIntegrationSchema } from "@/lib/validations";
import { apiError, zodErrorResponse, unauthorizedResponse, forbiddenResponse, internalErrorResponse } from "@/lib/api-errors";

const INTEGRATION_SAFE_SELECT = {
  id: true,
  name: true,
  slug: true,
  isActive: true,
  departmentId: true,
  department: { select: { id: true, name: true } },
  defaultCategoryId: true,
  defaultCategory: { select: { id: true, name: true } },
  defaultPriorityId: true,
  defaultPriority: { select: { id: true, name: true } },
  baseUrl: true,
  apiKeyPrefix: true,
  lastUsedAt: true,
  createdById: true,
  createdBy: { select: { id: true, name: true, email: true } },
  createdAt: true,
  updatedAt: true,
  _count: { select: { tickets: true } },
} as const;

async function requireIntegrationManage() {
  const session = await requireAuth();
  const allowed = await hasPermission(session.user.role, "integration.manage", session.user.customRoleId);
  if (!allowed) throw new Error("Forbidden");
  return session;
}

// PATCH — edit name/department/defaults/baseUrl/isActive. Never touches the
// API key (see the dedicated rotate route) or the slug (immutable once
// created).
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    await requireIntegrationManage();
  } catch (error: any) {
    if (error.message === "Unauthorized") return unauthorizedResponse();
    return forbiddenResponse("You do not have permission to manage integrations.");
  }

  try {
    const existing = await prisma.externalIntegration.findUnique({ where: { id }, select: { departmentId: true } });
    if (!existing) return NextResponse.json(apiError("item_not_found", "This integration no longer exists."), { status: 404 });

    const body = await req.json();
    const parsed = updateIntegrationSchema.safeParse(body);
    if (!parsed.success) return zodErrorResponse(parsed.error);
    const data = parsed.data;

    // The effective department for validating defaultCategoryId/
    // defaultPriorityId against — the incoming departmentId if this call is
    // also moving the integration, else its current one.
    const effectiveDepartmentId = data.departmentId ?? existing.departmentId;

    if (data.departmentId) {
      const department = await prisma.department.findUnique({ where: { id: data.departmentId }, select: { id: true } });
      if (!department) {
        return NextResponse.json(apiError("invalid_department", "The selected department does not exist.", { field: "departmentId" }), { status: 400 });
      }
    }

    if (data.defaultCategoryId) {
      const category = await prisma.ticketCategory.findUnique({ where: { id: data.defaultCategoryId }, select: { departmentId: true, isActive: true } });
      if (!category || !category.isActive || category.departmentId !== effectiveDepartmentId) {
        return NextResponse.json(
          apiError("category_department_mismatch", "defaultCategoryId must be an active category belonging to this integration's department.", { field: "defaultCategoryId" }),
          { status: 422 }
        );
      }
    }
    if (data.defaultPriorityId) {
      const priority = await prisma.ticketPriority.findUnique({ where: { id: data.defaultPriorityId }, select: { departmentId: true, isActive: true } });
      if (!priority || !priority.isActive || priority.departmentId !== effectiveDepartmentId) {
        return NextResponse.json(
          apiError("priority_department_mismatch", "defaultPriorityId must be an active priority belonging to this integration's department.", { field: "defaultPriorityId" }),
          { status: 422 }
        );
      }
    }

    const integration = await prisma.externalIntegration.update({
      where: { id },
      data: {
        name: data.name,
        departmentId: data.departmentId,
        defaultCategoryId: data.defaultCategoryId,
        defaultPriorityId: data.defaultPriorityId,
        baseUrl: data.baseUrl,
        isActive: data.isActive,
      },
      select: INTEGRATION_SAFE_SELECT,
    });

    return NextResponse.json(integration);
  } catch (error: any) {
    if (error.code === "P2025") {
      return NextResponse.json(apiError("item_not_found", "This integration no longer exists."), { status: 404 });
    }
    return internalErrorResponse();
  }
}
