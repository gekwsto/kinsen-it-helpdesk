import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { processDueSqlGeneralUserSyncs } from "@/lib/services/sqlgeneral-user-sync-service";

// Worker trigger for SQLGeneral Organization Sync. Same scheduler
// architecture as /api/internal/mention-reminders/process: Vercel Cron (GET,
// vercel.json) or, in the Docker Compose deployment, the
// kinsen-helpdesk-sqlgeneral-user-sync-worker sidecar. Authenticated with
// the CRON_SECRET bearer token; fails closed in production when no secret
// is configured. Safe to invoke concurrently and repeatedly — every claim/
// transition is an atomic database operation, and the processor itself
// claims nothing at all while SQLGENERAL_SYNC_ENABLED isn't "true" (see
// processDueSqlGeneralUserSyncs).
export const dynamic = "force-dynamic";

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return process.env.NODE_ENV !== "production";
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  return !!token && safeEqual(token, secret);
}

async function handle(req: NextRequest) {
  if (!isAuthorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    return NextResponse.json({ success: true, ...(await processDueSqlGeneralUserSyncs()) });
  } catch (err) {
    console.error("[sqlgeneral-user-sync] worker run failed:", err instanceof Error ? err.name : "unknown");
    return NextResponse.json({ error: "Processing failed" }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
