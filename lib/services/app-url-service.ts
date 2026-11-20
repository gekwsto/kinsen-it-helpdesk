/**
 * Validates and resolves the canonical public origin used to build
 * absolute links returned by server-to-server APIs — currently, the
 * integration ticket-creation response's `ticket.url`
 * (app/api/integrations/tickets/route.ts).
 *
 * Deliberately NOT derived from the request's Host/X-Forwarded-* headers
 * — those are caller-controllable; APP_URL is server-only configuration,
 * trusted precisely because a request can never influence it (same
 * rationale already documented at each of this app's existing, pre-
 * existing APP_URL read sites: lib/ticket-notification-service.ts,
 * lib/ticket-email-service.ts, lib/services/project-feedback-service.ts —
 * none of which validate the value today; this module is intentionally
 * scoped to the NEW integration-API consumer only, which has a sharper
 * requirement than those email-link use cases: `ticket.url` is a
 * machine-consumed API field an external caller may act on
 * programmatically, not a link a human reads in an email and might
 * shrug off if it looks slightly off).
 *
 * FAILS LOUDLY rather than silently emitting a malformed or insecure
 * link: a misconfigured APP_URL throws AppUrlMisconfiguredError, which
 * the integration route maps to the same controlled
 * `503 configuration_required` contract already used for a missing
 * INTEGRATION_KEY_PEPPER (see lib/services/integration-key-service.ts's
 * IntegrationPepperMissingError — the same established pattern).
 */

export class AppUrlMisconfiguredError extends Error {
  constructor(public reason: string) {
    super(`APP_URL is misconfigured: ${reason}`);
    this.name = "AppUrlMisconfiguredError";
  }
}

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * Re-validated on every call — no caching. This is a single URL parse,
 * microseconds of work, and correctness matters far more here than that
 * negligible per-request cost; a value that is valid at process start
 * could not actually change at runtime in practice, but there is no
 * benefit to assuming that versus just checking.
 *
 * `opts` is a test seam only (default `process.env.APP_URL`/
 * `process.env.NODE_ENV` otherwise) — see
 * scripts/test-integration-rate-limit-and-app-url.ts.
 *
 * Returns the validated origin ONLY — scheme + host + port, e.g.
 * "https://helpdesk.example.com" — never a trailing slash, path, query,
 * or fragment. This IS the "normalize trailing slashes" step: URL.origin
 * is spec-guaranteed to be exactly that clean form, so any trailing
 * slash or stray path component an operator mistakenly included in
 * APP_URL (e.g. "https://helpdesk.example.com/app/") is discarded here
 * once, rather than leaking into every link built from it.
 */
export function resolveAppOrigin(opts?: { rawAppUrl?: string; nodeEnv?: string }): string {
  const raw = opts?.rawAppUrl ?? process.env.APP_URL ?? "http://localhost:3000";
  const nodeEnv = opts?.nodeEnv ?? process.env.NODE_ENV;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new AppUrlMisconfiguredError(`"${raw}" is not a valid absolute URL.`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new AppUrlMisconfiguredError(`protocol must be http: or https: (got "${parsed.protocol}" from "${raw}").`);
  }

  const isLocal = LOCAL_HOSTNAMES.has(parsed.hostname);
  // Require HTTPS in production; HTTP is permitted only for local
  // development — interpreted as EITHER a non-production NODE_ENV (the
  // ordinary "running locally" case) OR an explicitly local hostname
  // (covers running a production build locally, e.g. `next build && next
  // start` with NODE_ENV=production on a dev machine). Any other
  // production, non-local, http: URL is rejected.
  if (parsed.protocol === "http:" && nodeEnv === "production" && !isLocal) {
    throw new AppUrlMisconfiguredError(
      `protocol must be https: in production (got "${raw}") — http: is only permitted for localhost/127.0.0.1 or outside production.`
    );
  }

  return parsed.origin;
}

/**
 * Builds one absolute URL from a validated origin using the URL API
 * (never string concatenation) — `new URL(path, origin)` correctly joins
 * regardless of leading/trailing slashes on either side.
 */
export function buildAbsoluteAppUrl(pathAndQuery: string, opts?: { rawAppUrl?: string; nodeEnv?: string }): string {
  const origin = resolveAppOrigin(opts);
  return new URL(pathAndQuery, origin).toString();
}
