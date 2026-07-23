import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { requireAdmin } from "@/lib/permissions";
import { updateMicrosoftMappingSchema } from "@/lib/validations";
import { updateMapping, deleteMapping, MicrosoftMappingValidationError } from "@/lib/services/microsoft-mapping-service";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireAdmin();
    const { id } = await params;
    const body = await req.json();
    const data = updateMicrosoftMappingSchema.parse(body);
    const mapping = await updateMapping(id, data);
    return NextResponse.json(mapping);
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
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === "P2002") {
        return NextResponse.json({ error: "A mapping for this value already exists.", code: "duplicate_mapping" }, { status: 409 });
      }
      if (error.code === "P2025") {
        return NextResponse.json({ error: "Not found", code: "not_found" }, { status: 404 });
      }
    }
    if (error.message === "Unauthorized") return NextResponse.json({ error: "Unauthorized", code: "unauthorized" }, { status: 401 });
    if (error.message === "Forbidden") return NextResponse.json({ error: "Forbidden", code: "missing_permission" }, { status: 403 });
    return NextResponse.json({ error: "Internal error", code: "internal_error" }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireAdmin();
    const { id } = await params;
    await deleteMapping(id);
    return new NextResponse(null, { status: 204 });
  } catch (error: any) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
      return NextResponse.json({ error: "Not found", code: "not_found" }, { status: 404 });
    }
    if (error.message === "Unauthorized") return NextResponse.json({ error: "Unauthorized", code: "unauthorized" }, { status: 401 });
    if (error.message === "Forbidden") return NextResponse.json({ error: "Forbidden", code: "missing_permission" }, { status: 403 });
    return NextResponse.json({ error: "Internal error", code: "internal_error" }, { status: 500 });
  }
}
