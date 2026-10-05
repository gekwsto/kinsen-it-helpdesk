import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/permissions";

// GET — every ACTIVE Project Expense Type, for the request-origin Project
// setup form's dropdown. Any authenticated user may call this (completing
// setup for an approved request needs no special permission beyond being
// its recorded final approver, checked at submission time) — this is a
// read of a small global reference list, not a scope-sensitive query.
export async function GET() {
  try {
    await requireAuth();
    const types = await prisma.projectExpenseType.findMany({
      where: { isActive: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    });
    return NextResponse.json(types);
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
}
