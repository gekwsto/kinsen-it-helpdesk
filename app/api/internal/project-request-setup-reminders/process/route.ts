import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { processDueProjectRequestSetupReminders } from "@/lib/services/project-request-setup-reminder-service";

// Worker trigger for Project Request setup reminders — same scheduler
// architecture as /api/internal/mention-reminders/process: Vercel Cron (GET,
// vercel.json) or, in the Docker Compose deployment, the
// kinsen-helpdesk-project-request-setup-reminder-worker sidecar. Authenticated
// with the CRON_SECRET bearer token; fails closed in production when no
// secret is configured. Safe to invoke concurrently and repeatedly — every
// claim/transition is an atomic database operation.
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
    return NextResponse.json({ success: true, ...(await processDueProjectRequestSetupReminders()) });
  } catch (err) {
    console.error("[project-request-setup-reminders] worker run failed:", err instanceof Error ? err.name : "unknown");
    return NextResponse.json({ error: "Processing failed" }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
