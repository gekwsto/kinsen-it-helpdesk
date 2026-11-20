/**
 * Minimal per-integration rate limiter, shared by POST /api/integrations/
 * tickets (ticket creation) and POST /api/integrations/tickets/[ticketId]/
 * attachments (attachment upload).
 *
 * IN-MEMORY, DELIBERATELY — VERIFIED SAFE FOR THIS DEPLOYMENT: production
 * runs as exactly ONE Next.js app container (see docker-compose.yml's
 * `kinsen-helpdesk` service — no `deploy.replicas`, no load balancer in
 * front of multiple app instances; the other services in that file are
 * curl-based cron-style workers that call INTO this one app over the
 * internal network, never additional copies of the app itself). A
 * per-process Map is therefore exactly as correct here as a shared/
 * external store would be, with none of the operational cost (no Redis,
 * no new dependency) — this app already relies on the identical single-
 * process assumption elsewhere (e.g. lib/services/organization-tree-
 * service.ts's in-process cache, lib/realtime/event-bus.ts). If this app
 * is ever horizontally scaled to multiple app instances, this module's
 * state would need to move to a shared store (Postgres or Redis) — this
 * comment is the tripwire for that future change, not a decision to make
 * preemptively for a topology that doesn't exist today.
 *
 * KEYED ONLY BY A VERIFIED INTEGRATION ID — callers in both routes apply
 * this AFTER verifyIntegrationKey already succeeded, never before. This
 * is what keeps the bucket map's size bounded: the key space is exactly
 * "however many ExternalIntegration rows currently exist" (admin-created,
 * small, finite), never attacker-controlled. An invalid/unknown/malformed
 * API key is rejected by auth and never reaches this module at all, so it
 * can never grow this map — there is nothing here for a flood of bad keys
 * to exhaust.
 *
 * FIXED WINDOW, NOT SLIDING — a deliberate simplicity trade-off ("keep the
 * implementation lightweight"): a burst can land up to ~2x the configured
 * limit across a window boundary. Acceptable for this endpoint's actual
 * threat model (abuse/misbehaving-caller protection, not a strict quota
 * system) — a sliding window would be a few more lines but isn't needed
 * to meet the stated requirement.
 */

export type IntegrationRateLimitScope = "ticket_creation" | "attachment_upload";

const WINDOW_MS = 60_000;

/**
 * Defaults match the current single-process capacity with comfortable
 * headroom for a legitimate automated caller, while still bounding abuse.
 * Configurable per scope via env vars so an operator can tune without a
 * code change.
 */
function defaultLimitForScope(scope: IntegrationRateLimitScope): number {
  if (scope === "ticket_creation") {
    const configured = Number(process.env.INTEGRATION_TICKET_RATE_LIMIT_PER_MINUTE);
    return Number.isFinite(configured) && configured > 0 ? configured : 60;
  }
  const configured = Number(process.env.INTEGRATION_ATTACHMENT_RATE_LIMIT_PER_MINUTE);
  return Number.isFinite(configured) && configured > 0 ? configured : 120;
}

interface Bucket {
  count: number;
  windowStart: number;
}

// One Map per scope — a caller hitting its ticket-creation limit must
// never consume or be blocked by its (independent) attachment-upload
// allowance, and vice versa.
const buckets: Record<IntegrationRateLimitScope, Map<string, Bucket>> = {
  ticket_creation: new Map(),
  attachment_upload: new Map(),
};

export type RateLimitCheckResult = { allowed: true } | { allowed: false; retryAfterSeconds: number };

/**
 * `opts` is a test seam only (default limit/window/now otherwise) — see
 * scripts/test-integration-rate-limit-and-app-url.ts.
 */
export function checkIntegrationRateLimit(
  integrationId: string,
  scope: IntegrationRateLimitScope,
  opts?: { limit?: number; windowMs?: number; now?: number }
): RateLimitCheckResult {
  const limit = opts?.limit ?? defaultLimitForScope(scope);
  const windowMs = opts?.windowMs ?? WINDOW_MS;
  const now = opts?.now ?? Date.now();

  const bucketMap = buckets[scope];
  const existing = bucketMap.get(integrationId);

  if (!existing || now - existing.windowStart >= windowMs) {
    bucketMap.set(integrationId, { count: 1, windowStart: now });
    return { allowed: true };
  }

  if (existing.count < limit) {
    existing.count += 1;
    return { allowed: true };
  }

  const retryAfterSeconds = Math.max(1, Math.ceil((existing.windowStart + windowMs - now) / 1000));
  return { allowed: false, retryAfterSeconds };
}

/** Test-only: clears all buckets so a fresh scenario starts with a clean slate. Never called from application code. */
export function resetIntegrationRateLimiterForTests(): void {
  buckets.ticket_creation.clear();
  buckets.attachment_upload.clear();
}

/** Test-only: the current number of distinct integrations tracked for a scope — used to prove invalid-auth attempts never grow this map. Never called from application code. */
export function getIntegrationRateLimiterSizeForTests(scope: IntegrationRateLimitScope): number {
  return buckets[scope].size;
}
