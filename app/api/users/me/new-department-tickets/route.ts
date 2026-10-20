import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { apiError, unauthorizedResponse } from "@/lib/api-errors";

// The caller's OWN "New Department Tickets" preference — same self-only
// shape as GET/PATCH /api/users/me/mention-reminders (no user id in path or
// body, so it can never be pointed at anyone else). Defaults to false
// (opt-in) for a user with no explicit preference row yet, matching the
// column's own DB default.
export async function GET() {
  try {
    const session = await requireAuth();
    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { newDepartmentTicketsEnabled: true },
    });
    return NextResponse.json({ enabled: user?.newDepartmentTicketsEnabled ?? false });
  } catch {
    return unauthorizedResponse();
  }
}

export async function PATCH(req: NextRequest) {
  let userId: string;
  try {
    userId = (await requireAuth()).user.id;
  } catch {
    return unauthorizedResponse();
  }
  const body = await req.json().catch(() => null);
  if (!body || typeof body.enabled !== "boolean") {
    return NextResponse.json(apiError("invalid_payload", "enabled must be true or false."), { status: 400 });
  }
  await prisma.user.update({ where: { id: userId }, data: { newDepartmentTicketsEnabled: body.enabled } });
  return NextResponse.json({ enabled: body.enabled });
}
