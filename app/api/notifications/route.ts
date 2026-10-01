import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";

export async function GET() {
  try {
    const session = await requireAuth();
    // unreadCount is a true, table-wide COUNT — deliberately NOT derived by
    // filtering the `take: 50` display list below. Once a user has more
    // than 50 notifications, an unread one can sit outside that window
    // (e.g. older rows with no recent activity on them) and filtering the
    // slice would silently undercount the real unread total, which is what
    // this GET's own response is supposed to be the authoritative
    // reconciliation for (see hooks/use-notification-realtime.ts's
    // onReconnect / notification-dropdown.tsx's fetchNotifications).
    const [notifications, unreadCount] = await Promise.all([
      prisma.notification.findMany({
        where: { userId: session.user.id },
        orderBy: { createdAt: "desc" },
        take: 50,
      }),
      prisma.notification.count({ where: { userId: session.user.id, isRead: false } }),
    ]);
    return NextResponse.json({ notifications, unreadCount });
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
}
