import { NextRequest, NextResponse } from "next/server";
import { processInboundEmails } from "@/lib/ticket-email-service";

// Email inbound processing endpoint.
// Called by:
//   1. Vercel Cron (GET, every 2 min) — Authorization: Bearer ${CRON_SECRET}
//   2. Webhook / manual curl (POST)   — Authorization: Bearer ${EMAIL_WEBHOOK_SECRET}
//   3. Admin "Poll Now" button        — via /api/admin/email/poll (uses session auth)
//
// Docker / server cron — add to crontab:
//   (every 2 min) curl -s -X POST https://your-domain/api/email/inbound
//                      -H "Authorization: Bearer $EMAIL_WEBHOOK_SECRET"
function isAuthorized(req: NextRequest): boolean {
  const webhookSecret = process.env.EMAIL_WEBHOOK_SECRET;
  const cronSecret = process.env.CRON_SECRET;

  // If neither secret is configured (dev/test), allow all
  if (!webhookSecret && !cronSecret) return true;

  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return false;

  return (
    (!!webhookSecret && token === webhookSecret) ||
    (!!cronSecret && token === cronSecret)
  );
}

async function handle(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await processInboundEmails();
    return NextResponse.json({
      success: true,
      ...result,
      message: `Created ${result.created}, appended ${result.appended}, skipped ${result.skipped}, errors ${result.errors}`,
    });
  } catch (error: any) {
    console.error("Email processing error:", error);
    return NextResponse.json(
      { error: error.message ?? "Processing failed" },
      { status: 500 }
    );
  }
}

// Vercel Cron sends GET; manual callers use POST
export const GET = handle;
export const POST = handle;
