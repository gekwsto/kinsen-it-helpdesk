import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/permissions";

// GET — every ACTIVE Task Sub Type (formerly "Activity Task Type" — see
// TaskSubType in prisma/schema.prisma), for the Activity creation form's
// dropdown. Any authenticated user may call this (creating an Activity
// needs no special permission beyond activity.create, checked at
// submission time) — this is a read of a small global reference list, not
// a scope-sensitive query. cost IS included here (unlike
// /api/project-expense-types, which has no cost at all) — shown as
// readonly informational data once a Task Sub Type is selected, never as
// a client-editable/authoritative value. `null` means "no fixed
// configured cost" and is passed through as-is — NEVER coerced to 0
// (Number(null) === 0 would silently fabricate a cost that was never
// configured).
export async function GET() {
  try {
    await requireAuth();
    const types = await prisma.taskSubType.findMany({
      where: { isActive: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true, cost: true },
    });
    return NextResponse.json(types.map((t) => ({ ...t, cost: t.cost === null ? null : Number(t.cost) })));
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
}
