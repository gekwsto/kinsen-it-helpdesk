import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { requireAdmin } from "@/lib/permissions";
import { createMicrosoftMappingSchema } from "@/lib/validations";
import { listMappings, createMapping, MicrosoftMappingValidationError } from "@/lib/services/microsoft-mapping-service";

// Cross-department system configuration — System Admin only, unlike
// department settings/members which a Department Admin can also manage.

export async function GET() {
  try {
    await requireAdmin();
    const mappings = await listMappings();
    return NextResponse.json(mappings);
  } catch {
    return NextResponse.json({ error: "Forbidden", code: "missing_permission" }, { status: 403 });
  }
}

export async function POST(req: NextRequest) {
  try {
    await requireAdmin();
    const body = await req.json();
    const data = createMicrosoftMappingSchema.parse(body);
    const mapping = await createMapping(data);
    return NextResponse.json(mapping, { status: 201 });
  } catch (error: any) {
    if (error.name === "ZodError") {
      return NextResponse.json({ error: error.errors }, { status: 422 });
    }
    if (error instanceof MicrosoftMappingValidationError) {
      if (error.code === "ROLE_NOT_ALLOWED_FOR_MICROSOFT_MAPPING") {
        return NextResponse.json(
          { error: "This role cannot be granted via a Microsoft mapping — Microsoft mappings can never grant System Admin.", code: "role_not_allowed", reason: "administrator" },
          { status: 400 }
        );
      }
      if (error.code === "DEPARTMENT_ROLE_NOT_ALLOWED_FOR_MICROSOFT_MAPPING") {
        return NextResponse.json(
          { error: "This department role cannot be granted via a Microsoft mapping — Microsoft mappings can never grant Department Admin.", code: "role_not_allowed", reason: "department_admin" },
          { status: 400 }
        );
      }
      if (error.code === "DEPARTMENT_NOT_FOUND") {
        return NextResponse.json({ error: "Department not found.", code: "department_not_found" }, { status: 404 });
      }
      if (error.code === "DOMAIN_REQUIRED_FOR_SOURCE_TYPE") {
        return NextResponse.json(
          { error: "This mapping type requires a domain.", code: "domain_required" },
          { status: 400 }
        );
      }
      if (error.code === "DOMAIN_NOT_ALLOWED") {
        return NextResponse.json(
          { error: "This domain is not enabled for organization sync — only the configured ALLOWED_EMAIL_DOMAIN is accepted today.", code: "domain_not_allowed" },
          { status: 400 }
        );
      }
      if (error.code === "GLOBAL_CUSTOM_ROLE_NOT_FOUND" || error.code === "DEPARTMENT_CUSTOM_ROLE_NOT_FOUND") {
        return NextResponse.json({ error: "The selected role no longer exists.", code: "custom_role_not_found" }, { status: 404 });
      }
      if (error.code === "GLOBAL_CUSTOM_ROLE_INVALID") {
        return NextResponse.json(
          { error: "That role can't be used as a Global Role — it's either a built-in role or scoped to a department only.", code: "custom_role_invalid_scope" },
          { status: 400 }
        );
      }
      if (error.code === "DEPARTMENT_CUSTOM_ROLE_INVALID") {
        return NextResponse.json(
          { error: "That role can't be used as a Department Role — it's either a built-in role or scoped globally only.", code: "custom_role_invalid_scope" },
          { status: 400 }
        );
      }
      if (error.code === "GLOBAL_CUSTOM_ROLE_INACTIVE" || error.code === "DEPARTMENT_CUSTOM_ROLE_INACTIVE") {
        return NextResponse.json(
          { error: "That role is disabled and can't be newly assigned — enable it first or choose another role.", code: "custom_role_inactive" },
          { status: 400 }
        );
      }
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return NextResponse.json({ error: "A mapping for this value already exists.", code: "duplicate_mapping" }, { status: 409 });
    }
    if (error.message === "Unauthorized") return NextResponse.json({ error: "Unauthorized", code: "unauthorized" }, { status: 401 });
    if (error.message === "Forbidden") return NextResponse.json({ error: "Forbidden", code: "missing_permission" }, { status: 403 });
    return NextResponse.json({ error: "Internal error", code: "internal_error" }, { status: 500 });
  }
}
