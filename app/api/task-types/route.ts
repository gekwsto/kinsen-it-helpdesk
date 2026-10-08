import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/permissions";

// GET — every ACTIVE Task Type (formerly "Project Request Type" — see
// TaskType in prisma/schema.prisma), for the Activity creation/edit
// form's REQUIRED Task Type dropdown. Any authenticated user may call
// this (creating an Activity needs no special permission beyond the
// existing activity.create/activity.edit gates, checked at write time) —
// this is a read of a small global reference list, not a scope-sensitive
// query. Ordered alphabetically for a picker (deterministic); the admin
// management surface (/api/admin/task-types) separately orders its own
// list by createdAt for a stable audit view.
export async function GET() {
  try {
    await requireAuth();
    const types = await prisma.taskType.findMany({
      where: { isActive: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    });
    return NextResponse.json(types);
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
}
