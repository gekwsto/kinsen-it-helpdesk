import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { SqlGeneralTreeSnapshotTrigger } from "@prisma/client";
import { refreshSqlGeneralOrganizationTreeSnapshot } from "@/lib/services/sqlgeneral-tree-snapshot-service";

export const dynamic = "force-dynamic";

// Same CRON_SECRET + timingSafeEqual pattern as every other internal
// worker route in this codebase (e.g. app/api/internal/sqlgeneral-user-sync/process) —
// fails closed in production when CRON_SECRET is unset.
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

// GET/POST /api/internal/sqlgeneral-tree-snapshot/process — triggered
// HOURLY (Vercel Cron: "0 * * * *", same existing cadence as
// project-request-setup-reminders/process) and/or every 5 minutes via a
// docker-compose sidecar, same idiom as every other worker here. A real
// SQLGeneral rebuild only actually happens on the ONE invocation per
// calendar day where refreshSqlGeneralOrganizationTreeSnapshot's own
// isDueForDailySqlGeneralTreeRefresh guard (Europe/Athens calendar date +
// a 03:00 local target hour, DST-safe) says it's due — every other
// invocation is a cheap no-op DB read, never a live SQLGeneral fetch.
// Running more than one copy/trigger is safe: overlapping runs are
// rejected by the snapshot's own lock, never started concurrently, and a
// crashed run's abandoned lock/row is recovered automatically (see that
// function's own doc comment).
async function handle(req: NextRequest) {
  if (!isAuthorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const result = await refreshSqlGeneralOrganizationTreeSnapshot({ trigger: SqlGeneralTreeSnapshotTrigger.CRON });
    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    console.error("[sqlgeneral-tree-snapshot] worker run failed:", err instanceof Error ? err.name : "unknown");
    return NextResponse.json({ error: "Processing failed" }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
