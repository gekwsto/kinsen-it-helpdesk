import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { hasPermission } from "@/lib/permissions";

// DELETE /api/dependencies/[id]
// Same `activity.dependency.manage` gate as POST /api/dependencies — see
// that route's own doc comment.
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const allowed = await hasPermission(session.user.role, "activity.dependency.manage", session.user.customRoleId);
  if (!allowed) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;

  const dep = await prisma.activityDependency.findUnique({ where: { id } });
  if (!dep) return NextResponse.json({ error: "Dependency not found" }, { status: 404 });

  await prisma.activityDependency.delete({ where: { id } });
  return NextResponse.json({ success: true });
}
