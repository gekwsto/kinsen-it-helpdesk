import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { setMentionRemindersEnabled } from "@/lib/services/mention-reminder-service";
import { apiError, unauthorizedResponse } from "@/lib/api-errors";

// The caller's OWN "Mention reminders" preference — there is deliberately no
// user id in the path or body, so it cannot be pointed at anyone else.
export async function GET() {
  try {
    const session = await requireAuth();
    const user = await prisma.user.findUnique({ where: { id: session.user.id }, select: { mentionRemindersEnabled: true } });
    return NextResponse.json({ enabled: user?.mentionRemindersEnabled ?? true });
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
  const { cancelled } = await setMentionRemindersEnabled(userId, body.enabled);
  return NextResponse.json({ enabled: body.enabled, cancelled });
}
