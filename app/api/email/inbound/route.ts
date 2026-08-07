import { NextRequest, NextResponse } from "next/server";
import { processInboundEmails } from "@/lib/ticket-email-service";

// Email inbound processing endpoint — polls EVERY configured mailbox
// (central support mailbox + every active department's own inboundEmail,
// see lib/services/inbound-mailbox-service.ts), not just one hardcoded
// address. Called by:
//   1. Vercel Cron (GET, every 2 min) — Authorization: Bearer ${CRON_SECRET}
//   2. Webhook / manual curl (POST)   — Authorization: Bearer ${EMAIL_WEBHOOK_SECRET}
//   3. Admin "Poll Now" button        — via /api/admin/email/poll (uses session auth)
//   4. Docker Compose email-poller sidecar (POST, every 2 min, internal
//      network only) — see docker-compose.yml's kinsen-helpdesk-email-poller
//      service, which is how the Docker deployment gets the SAME ~2-minute
//      polling Vercel Cron provides on Vercel (docker-compose.yml has no
//      cron of its own otherwise, and vercel.json's cron does nothing when
//      the app runs via Docker instead of Vercel).
function isAuthorized(req: NextRequest): boolean {
  const webhookSecret = process.env.EMAIL_WEBHOOK_SECRET;
  const cronSecret = process.env.CRON_SECRET;

  if (!webhookSecret && !cronSecret) {
    // Fail SECURE in production: this endpoint triggers real Graph polling
    // and DB writes, so it must never be silently public just because an
    // operator forgot to set EMAIL_WEBHOOK_SECRET/CRON_SECRET. Dev/test only
    // keeps the permissive default (no secret configured locally is normal).
    return process.env.NODE_ENV !== "production";
  }

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
