import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, hasPermission } from "@/lib/permissions";
import { slugify } from "@/lib/services/department-service";
import { generateUniqueIntegrationKey } from "@/lib/services/integration-key-service";
import { createIntegrationSchema } from "@/lib/validations";
import { apiError, zodErrorResponse, unauthorizedResponse, forbiddenResponse, internalErrorResponse } from "@/lib/api-errors";

// Every field except apiKeyHash — the raw key is shown to an admin exactly
// once (see POST/[id]/rotate below) and the hash itself must never leave
// the server, so it's simply never selected here rather than selected-then-
// stripped (no risk of a future edit accidentally forwarding it).
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

async function generateUniqueIntegrationSlug(name: string): Promise<string> {
  const base = slugify(name) || "integration";
  let candidate = base;
  let suffix = 2;
  while (await prisma.externalIntegration.findUnique({ where: { slug: candidate }, select: { id: true } })) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

export async function GET() {
  try {
    const session = await requireAuth();
    const allowed = await hasPermission(session.user.role, "integration.manage", session.user.customRoleId);
    if (!allowed) return forbiddenResponse("You do not have permission to manage integrations.");

    const integrations = await prisma.externalIntegration.findMany({
      orderBy: { createdAt: "desc" },
      select: INTEGRATION_SAFE_SELECT,
    });
    return NextResponse.json(integrations);
  } catch (error: any) {
    if (error.message === "Unauthorized") return unauthorizedResponse();
    return internalErrorResponse();
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await requireAuth();
    const allowed = await hasPermission(session.user.role, "integration.manage", session.user.customRoleId);
    if (!allowed) return forbiddenResponse("You do not have permission to manage integrations.");

    const body = await req.json();
    const parsed = createIntegrationSchema.safeParse(body);
    if (!parsed.success) return zodErrorResponse(parsed.error);
    const data = parsed.data;

    const department = await prisma.department.findUnique({ where: { id: data.departmentId }, select: { id: true } });
    if (!department) {
      return NextResponse.json(apiError("invalid_department", "The selected department does not exist.", { field: "departmentId" }), { status: 400 });
    }

    if (data.defaultCategoryId) {
      const category = await prisma.ticketCategory.findUnique({ where: { id: data.defaultCategoryId }, select: { departmentId: true, isActive: true } });
      if (!category || !category.isActive || category.departmentId !== data.departmentId) {
        return NextResponse.json(
          apiError("category_department_mismatch", "defaultCategoryId must be an active category belonging to the selected department.", { field: "defaultCategoryId" }),
          { status: 422 }
        );
      }
    }
    if (data.defaultPriorityId) {
      const priority = await prisma.ticketPriority.findUnique({ where: { id: data.defaultPriorityId }, select: { departmentId: true, isActive: true } });
      if (!priority || !priority.isActive || priority.departmentId !== data.departmentId) {
        return NextResponse.json(
          apiError("priority_department_mismatch", "defaultPriorityId must be an active priority belonging to the selected department.", { field: "defaultPriorityId" }),
          { status: 422 }
        );
      }
    }

    const slug = await generateUniqueIntegrationSlug(data.name);
    const { rawKey, keyPrefix, keyHash } = await generateUniqueIntegrationKey();

    const integration = await prisma.externalIntegration.create({
      data: {
        name: data.name,
        slug,
        departmentId: data.departmentId,
        defaultCategoryId: data.defaultCategoryId,
        defaultPriorityId: data.defaultPriorityId,
        baseUrl: data.baseUrl,
        apiKeyPrefix: keyPrefix,
        apiKeyHash: keyHash,
        createdById: session.user.id,
      },
      select: INTEGRATION_SAFE_SELECT,
    });

    // The only place the raw key is ever returned — the admin UI must show
    // it in a "copy it now, it won't be shown again" modal and never
    // request it again afterward.
    return NextResponse.json({ integration, apiKey: rawKey }, { status: 201 });
  } catch (error: any) {
    if (error.message === "Unauthorized") return unauthorizedResponse();
    if (error.code === "P2002") {
      return NextResponse.json(apiError("duplicate_integration", "An integration with this name already exists.", { field: "name" }), { status: 409 });
    }
    return internalErrorResponse();
  }
}
