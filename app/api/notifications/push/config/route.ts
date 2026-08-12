import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/permissions";
import { isWebPushConfigured, getWebPushPublicKey } from "@/lib/web-push";

/**
 * Runtime Web Push configuration for the browser — the fix for the
 * production root cause where the client previously read
 * `process.env.NEXT_PUBLIC_WEB_PUSH_VAPID_PUBLIC_KEY` directly. That value
 * is build-time-inlined by Next.js into the static client bundle produced
 * during `next build` (the Dockerfile's `builder` stage). `.dockerignore`
 * excludes `.env` from the build context, and docker-compose.yml only
 * supplies `.env` via `env_file:` to the RUNTIME container (the `runner`
 * stage) — so the builder stage always saw an EMPTY
 * NEXT_PUBLIC_WEB_PUSH_VAPID_PUBLIC_KEY, permanently baking `""` into the
 * shipped browser bundle regardless of what the runtime container's real
 * environment contains. This endpoint reads the same env var, but on the
 * SERVER, at REQUEST TIME, inside the already-running runtime container —
 * which does have the real value from `env_file` — so the same Docker
 * image now works correctly no matter how the public key is supplied at
 * deploy time.
 *
 * Deliberately `requireAuth()`-gated (same rationale as every other
 * notifications/push route: this is a signed-in feature, not a public
 * one) and returns ONLY the VAPID PUBLIC key — intentionally public by
 * design, it's the exact value handed to PushManager.subscribe() as
 * `applicationServerKey`. The private key and contact email are NEVER
 * read or returned here; see lib/web-push.ts's getWebPushPublicKey, which
 * only returns a value when the server is fully configured.
 */
export async function GET() {
  try {
    await requireAuth();
    return NextResponse.json({
      configured: isWebPushConfigured(),
      publicKey: getWebPushPublicKey(),
    });
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
}
