import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/permissions";

// GET — every ACTIVE Task Type, for the request-origin Activity creation
// form's dropdown. Any authenticated user may call this (creating an
// Activity needs no special permission beyond activity.create, checked at
// submission time) — this is a read of a small global reference list, not
// a scope-sensitive query. Cost IS included here (unlike
// /api/project-expense-types, which has no cost at all) — the task
// explicitly allows showing it as readonly informational data once a Task
// Type is selected, never as a client-editable/authoritative value.
export async function GET() {
  try {
    await requireAuth();
    const types = await prisma.activityTaskType.findMany({
      where: { isActive: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true, cost: true },
    });
    return NextResponse.json(types.map((t) => ({ ...t, cost: Number(t.cost) })));
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
}
