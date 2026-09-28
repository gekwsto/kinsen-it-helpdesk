import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/permissions";
import { projectListChangeHub } from "@/lib/realtime/project-list-change-hub";
import { isAbsoluteSessionExpired } from "@/lib/session-expiry";

export const dynamic = "force-dynamic";

/**
 * List-level SSE stream for Projects — mirrors
 * app/api/tickets/stream/route.ts exactly (heartbeat, absolute
 * session-expiry enforcement, abort cleanup). Any authenticated user may
 * open this: it only ever sends a generic "PROJECTS_CHANGED" pulse with NO
 * project data whatsoever — the realtime transport is deliberately not an
 * authorization boundary. The client's only correct reaction is to re-run
 * its OWN already-authorized server-side Project query (router.refresh() on
 * the /projects Server Component page — see
 * components/projects/project-list-live-refresh.tsx) — that query is what
 * actually decides, per-viewer, what changed and whether it's visible.
 */
export async function GET(req: NextRequest) {
  let session: Awaited<ReturnType<typeof requireAuth>>;
  try {
    session = await requireAuth();
  } catch {
    return new Response("Unauthorized", { status: 401 });
  }

  const expiresAt = session.user.absoluteSessionExpiresAt;
  const encoder = new TextEncoder();
  let isClosed = false;

  const stream = new ReadableStream({
    start(controller) {
      const send = (data: object) => {
        if (isClosed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          isClosed = true;
        }
      };

      send({ type: "CONNECTED", createdAt: new Date().toISOString() });

      const unsubscribe = projectListChangeHub.subscribe(() => {
        send({ type: "PROJECTS_CHANGED", createdAt: new Date().toISOString() });
      });

      const heartbeat = setInterval(() => {
        if (isClosed) {
          clearInterval(heartbeat);
          return;
        }
        if (isAbsoluteSessionExpired(expiresAt)) {
          send({ type: "SESSION_EXPIRED", createdAt: new Date().toISOString() });
          isClosed = true;
          unsubscribe();
          clearInterval(heartbeat);
          try {
            controller.close();
          } catch {}
          return;
        }
        try {
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
        } catch {
          isClosed = true;
          clearInterval(heartbeat);
        }
      }, 20_000);

      req.signal.addEventListener("abort", () => {
        isClosed = true;
        unsubscribe();
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {}
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
