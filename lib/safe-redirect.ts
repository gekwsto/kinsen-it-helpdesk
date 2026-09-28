/**
 * Validates a user/query-supplied post-authentication destination against
 * open-redirect abuse — shared by app/auth/sso-entry/route.ts (the suite
 * entry point's `returnTo`) and app/(auth)/login/page.tsx (the existing
 * `callbackUrl` middleware already sets on an expired-session redirect,
 * previously read by nothing). No Node-only API — safe to import from an
 * Edge or Node runtime alike.
 *
 * The actual guarantee is the WHATWG URL parser itself: resolving the
 * candidate against a fixed, arbitrary internal base and checking the
 * result's `origin` still equals that base's origin is what the browser's
 * own URL resolution algorithm would do — it correctly rejects absolute
 * URLs, protocol-relative ("//evil.com"), backslash tricks ("\\evil.com",
 * "/\evil.com", all of which normalize to a different host for "special"
 * schemes like http/https), and "javascript:"/other non-http schemes
 * (origin resolves to `null`, never matching). Percent-encoded slashes
 * ("/%2F%2Fevil.com") stay literal path characters under this parser
 * (never decoded into path separators), so they can never smuggle in a
 * different host either — confirmed empirically, not just documented
 * behavior, before relying on it here.
 */

/** Used only to give the WHATWG URL parser a stable, un-guessable-by-input base to resolve candidates against — never itself reachable or meaningful. */
const RESOLUTION_BASE = "http://internal.invalid";

/** Safe fallback when the candidate is missing, malformed, or rejected — the existing Helpdesk landing route. */
export const DEFAULT_SAFE_DESTINATION = "/dashboard";

/**
 * Path prefixes that must never be used as a post-auth destination even
 * though they're technically same-origin relative paths — landing back on
 * one of these is exactly how a loop forms between suite entry, the login
 * page, Microsoft's authorize/callback routes, and expired-session
 * handling. `/api/auth` covers NextAuth's own signin/callback/signout
 * routes; `/auth/` covers this app's own suite-entry namespace; `/login`
 * and `/unauthorized` are the auth pages themselves.
 */
const DISALLOWED_PREFIXES = ["/login", "/auth/", "/api/auth", "/unauthorized"];

/**
 * Returns a safe, same-origin, relative "pathname + search + hash" string —
 * never the raw input. Any rejection (missing, non-relative, escapes
 * origin, malformed, or targets a disallowed auth-loop path) resolves to
 * `fallback` (default: the Helpdesk dashboard), never throws.
 */
export function sanitizeInternalDestination(
  candidate: string | null | undefined,
  fallback: string = DEFAULT_SAFE_DESTINATION
): string {
  if (typeof candidate !== "string" || candidate.length === 0) return fallback;

  const trimmed = candidate.trim();
  if (!trimmed.startsWith("/")) return fallback;
  // Belt-and-suspenders ahead of the origin check below — protocol-relative
  // URLs are already caught by that check too, but rejecting the obvious
  // shape outright keeps the intent explicit and needs no URL parsing.
  if (trimmed.startsWith("//") || trimmed.startsWith("/\\")) return fallback;

  let parsed: URL;
  try {
    parsed = new URL(trimmed, RESOLUTION_BASE);
  } catch {
    return fallback;
  }
  if (parsed.origin !== new URL(RESOLUTION_BASE).origin) return fallback;

  const normalized = `${parsed.pathname}${parsed.search}${parsed.hash}`;
  if (!normalized.startsWith("/")) return fallback;
  if (DISALLOWED_PREFIXES.some((prefix) => normalized === prefix.replace(/\/$/, "") || normalized.startsWith(prefix))) {
    return fallback;
  }

  return normalized;
}
