import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";

/**
 * Lets the client tell "browser has a PushManager subscription" apart from
 * "the server still has a matching PushSubscription row" — the two can
 * diverge (e.g. lib/web-push.ts removes a subscription after a 404/410
 * delivery failure, while the browser-side subscription object can persist
 * until it separately expires). Ownership-scoped: only ever reports on the
 * caller's OWN subscriptions, by exact endpoint.
 */
export async function GET(req: NextRequest) {
  try {
    const session = await requireAuth();
    const endpoint = req.nextUrl.searchParams.get("endpoint");
    if (!endpoint) return NextResponse.json({ subscribed: false });
    const existing = await prisma.pushSubscription.findFirst({
      where: { endpoint, userId: session.user.id },
      select: { id: true },
    });
    return NextResponse.json({ subscribed: !!existing });
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await requireAuth();
    const body = await req.json();
    const { endpoint, p256dh, auth } = body;
    if (!endpoint || !p256dh || !auth) {
      return NextResponse.json({ error: "Invalid subscription data" }, { status: 400 });
    }
    await prisma.pushSubscription.upsert({
      where: { endpoint },
      update: { p256dh, auth, userId: session.user.id },
      create: { userId: session.user.id, endpoint, p256dh, auth },
    });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
}
