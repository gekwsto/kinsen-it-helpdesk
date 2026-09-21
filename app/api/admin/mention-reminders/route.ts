import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/permissions";
import { getMentionReminderDelayMinutes, updateMentionReminderDelay } from "@/lib/services/mention-reminder-service";
import { describeMentionReminderDelay, parseMentionReminderDelay } from "@/lib/mention-reminders/config";
import { apiError, unauthorizedResponse, forbiddenResponse } from "@/lib/api-errors";

// Global Mention Reminder delay — System Admin only.
export async function GET() {
  try {
    await requireAdmin();
  } catch (error: any) {
    if (error.message === "Unauthorized") return unauthorizedResponse();
    return forbiddenResponse("Only an administrator can manage mention reminder settings.");
  }
  const delayMinutes = await getMentionReminderDelayMinutes();
  return NextResponse.json({ delayMinutes, ...describeMentionReminderDelay(delayMinutes) });
}

export async function PUT(req: NextRequest) {
  let adminId: string;
  try {
    adminId = (await requireAdmin()).user.id;
  } catch (error: any) {
    if (error.message === "Unauthorized") return unauthorizedResponse();
    return forbiddenResponse("Only an administrator can manage mention reminder settings.");
  }
  const body = await req.json().catch(() => null);
  const parsed = parseMentionReminderDelay(body?.value, body?.unit);
  if (!parsed.ok) return NextResponse.json(apiError("invalid_delay", parsed.error, { field: "value" }), { status: 400 });
  const { recalculated } = await updateMentionReminderDelay(parsed.minutes, adminId);
  return NextResponse.json({ delayMinutes: parsed.minutes, ...describeMentionReminderDelay(parsed.minutes), recalculated });
}
