import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isAdmin } from "@/lib/permissions";
import { buildActivityListWhere, canActOnEntity } from "@/lib/services/department-scope-service";
import { createDependencySchema } from "@/lib/validations";

// GET /api/dependencies?activityId=xxx
// Returns all deps where activity is predecessor or successor
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const activityId = req.nextUrl.searchParams.get("activityId");

  let where: any;
  if (activityId) {
    const activity = await prisma.projectActivity.findUnique({
      where: { id: activityId },
      select: { departmentId: true },
    });
    if (!activity) return NextResponse.json({ error: "Activity not found" }, { status: 404 });
    const canView = await canActOnEntity(session.user.id, session.user.role, activity.departmentId, "activity.view");
    if (!canView) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    where = { OR: [{ predecessorId: activityId }, { successorId: activityId }] };
  } else {
    // No activityId — this previously returned every dependency in the
    // system to any authenticated user. Scope to deps where at least one
    // endpoint is in an accessible department instead of trusting nothing.
    const scope = await buildActivityListWhere(session.user.id, session.user.role);
    if ("denied" in scope) {
      // buildActivityListWhere only denies for an explicit (here, absent)
      // requestedDepartmentId — unreachable, but fail closed regardless.
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    where = { OR: [{ predecessor: scope }, { successor: scope }] };
  }

  const deps = await prisma.activityDependency.findMany({
    where,
    include: {
      predecessor: { select: { id: true, title: true, status: true } },
      successor:   { select: { id: true, title: true, status: true } },
      createdBy:   { select: { id: true, name: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  return NextResponse.json(deps);
}

// POST /api/dependencies
// Admin-only: create a new dependency with cycle detection
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAdmin(session.user.role)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await req.json();
  const parsed = createDependencySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }

  const { predecessorId, successorId, type } = parsed.data;

  if (predecessorId === successorId) {
    return NextResponse.json({ error: "An activity cannot depend on itself" }, { status: 400 });
  }

  // Verify both activities exist
  const [pred, succ] = await Promise.all([
    prisma.projectActivity.findUnique({ where: { id: predecessorId }, select: { id: true } }),
    prisma.projectActivity.findUnique({ where: { id: successorId },   select: { id: true } }),
  ]);
  if (!pred) return NextResponse.json({ error: "Predecessor activity not found" }, { status: 404 });
  if (!succ) return NextResponse.json({ error: "Successor activity not found" }, { status: 404 });

  // BFS cycle detection: starting from successorId, check if we can reach predecessorId
  // (which would create a cycle if we add pred→succ)
  const visited = new Set<string>();
  const queue = [successorId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === predecessorId) {
      return NextResponse.json({ error: "This dependency would create a cycle" }, { status: 409 });
    }
    if (visited.has(current)) continue;
    visited.add(current);
    const outgoing = await prisma.activityDependency.findMany({
      where: { predecessorId: current },
      select: { successorId: true },
    });
    for (const o of outgoing) queue.push(o.successorId);
  }

  const dep = await prisma.activityDependency.create({
    data: {
      predecessorId,
      successorId,
      type,
      createdById: session.user.id,
    },
    include: {
      predecessor: { select: { id: true, title: true, status: true } },
      successor:   { select: { id: true, title: true, status: true } },
    },
  });

  return NextResponse.json(dep, { status: 201 });
}
