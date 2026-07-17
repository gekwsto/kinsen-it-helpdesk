import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/permissions";
import { createUserSchema } from "@/lib/validations";
import bcrypt from "bcryptjs";
import { AuthProvider } from "@prisma/client";

export async function GET(req: NextRequest) {
  try {
    await requireAdmin();
    const { searchParams } = new URL(req.url);
    const search = searchParams.get("search") ?? "";

    const where: any = {};
    if (search) {
      where.OR = [
        { name: { contains: search, mode: "insensitive" } },
        { email: { contains: search, mode: "insensitive" } },
      ];
    }

    const users = await prisma.user.findMany({
      where,
      orderBy: { name: "asc" },
      include: {
        department: { select: { id: true, name: true } },
        businessUnit: { select: { id: true, name: true } },
        customRole: { select: { id: true, key: true, name: true } },
        departmentMemberships: {
          include: { department: { select: { id: true, name: true, slug: true } } },
          orderBy: { createdAt: "asc" },
        },
      },
    });

    return NextResponse.json(users);
  } catch {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
}

export async function POST(req: NextRequest) {
  try {
    await requireAdmin();

    const body = await req.json();
    const data = createUserSchema.parse(body);

    const existing = await prisma.user.findUnique({ where: { email: data.email } });
    if (existing) {
      return NextResponse.json({ error: "Email already in use" }, { status: 409 });
    }

    const passwordHash = await bcrypt.hash(data.password, 12);

    const user = await prisma.user.create({
      data: {
        name: data.name,
        email: data.email,
        passwordHash,
        role: data.role,
        isActive: data.isActive,
        departmentId: data.departmentId || null,
        businessUnitId: data.businessUnitId || null,
        authProvider: AuthProvider.CREDENTIALS,
        mustChangePassword: true,
      },
      include: {
        department: { select: { id: true, name: true } },
        businessUnit: { select: { id: true, name: true } },
      },
    });

    return NextResponse.json(user, { status: 201 });
  } catch (error: any) {
    if (error.name === "ZodError") {
      return NextResponse.json({ error: error.errors }, { status: 422 });
    }
    if (error.message === "Forbidden" || error.message === "Unauthorized") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
