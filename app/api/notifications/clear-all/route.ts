import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";

// DELETE — clears EVERY notification belonging to the authenticated user
// (read or unread alike). Same shape/scope as POST .../mark-all-read, just
// deleting instead of flagging isRead.
export async function DELETE() {
  try {
    const session = await requireAuth();
    await prisma.notification.deleteMany({ where: { userId: session.user.id } });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
}
