import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { requireAdmin } from "@/lib/permissions";
import { createMicrosoftMappingSchema } from "@/lib/validations";
import { listMappings, createMapping } from "@/lib/services/microsoft-mapping-service";

// Cross-department system configuration — System Admin only, unlike
// department settings/members which a Department Admin can also manage.

export async function GET() {
  try {
    await requireAdmin();
    const mappings = await listMappings();
    return NextResponse.json(mappings);
  } catch {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
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
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return NextResponse.json({ error: "A mapping for this value already exists." }, { status: 409 });
    }
    if (error.message === "Unauthorized") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (error.message === "Forbidden") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
