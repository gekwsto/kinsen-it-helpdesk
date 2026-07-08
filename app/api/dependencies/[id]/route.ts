import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isAdmin } from "@/lib/permissions";

// DELETE /api/dependencies/[id]
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAdmin(session.user.role)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;

  const dep = await prisma.activityDependency.findUnique({ where: { id } });
  if (!dep) return NextResponse.json({ error: "Dependency not found" }, { status: 404 });

  await prisma.activityDependency.delete({ where: { id } });
  return NextResponse.json({ success: true });
}
