import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/permissions";
import { z } from "zod";

const createRoleSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters").max(50),
  description: z.string().optional(),
  key: z.string().regex(/^[a-zA-Z0-9_-]+$/, "Key must be alphanumeric with _ or -").optional(),
});

// GET — full data for the roles page: all custom roles + permissions + assignments
export async function GET(_req: NextRequest) {
  try {
    await requireAdmin();

    const [roles, permissions, rolePermissions] = await Promise.all([
      prisma.customRole.findMany({ orderBy: [{ isBuiltIn: "desc" }, { name: "asc" }] }),
      prisma.permission.findMany({ orderBy: [{ module: "asc" }, { key: "asc" }] }),
      prisma.rolePermission.findMany(),
    ]);

    return NextResponse.json({ roles, permissions, rolePermissions });
  } catch {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
}

// POST — create a new custom role
export async function POST(req: NextRequest) {
  try {
    await requireAdmin();

    const body = await req.json();
    const data = createRoleSchema.parse(body);

    // Generate key from name if not provided
    const key = data.key ?? data.name.toUpperCase().replace(/\s+/g, "_").replace(/[^A-Z0-9_]/g, "");

    const existing = await prisma.customRole.findUnique({ where: { key } });
    if (existing) {
      return NextResponse.json({ error: "A role with this key already exists" }, { status: 409 });
    }

    const role = await prisma.customRole.create({
      data: { key, name: data.name, description: data.description, isBuiltIn: false },
    });

    return NextResponse.json(role, { status: 201 });
  } catch (error: any) {
    if (error.name === "ZodError") {
      return NextResponse.json({ error: error.errors }, { status: 422 });
    }
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
