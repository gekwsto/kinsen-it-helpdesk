import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/permissions";

// GET — every ACTIVE Project Request Type, for the Project Request Form's
// dropdown. Any authenticated user may call this (submitting a request
// needs no special permission beyond an active department membership,
// checked at submission time) — this is a read of a small global reference
// list, not a scope-sensitive query. Ordered alphabetically for a picker
// (deterministic); the admin management surface (/api/admin/project-request-types)
// separately orders its own list by createdAt for a stable audit view.
export async function GET() {
  try {
    await requireAuth();
    const types = await prisma.projectRequestType.findMany({
      where: { isActive: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true, cost: true },
    });
    return NextResponse.json(types.map((t) => ({ ...t, cost: t.cost ? Number(t.cost) : null })));
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
}
