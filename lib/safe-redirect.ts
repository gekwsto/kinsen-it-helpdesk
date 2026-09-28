/**
 * Validates a user/query-supplied post-authentication destination against
 * open-redirect abuse — shared by app/auth/sso-entry/route.ts (the suite
 * entry point's `returnTo`) and app/(auth)/login/page.tsx (the `callbackUrl`
 * middleware/Auth.js's own default unauthorized-redirect sets, and what the
 * company suite currently sends when it redirects here). No Node-only API —
 * safe to import from an Edge or Node runtime alike.
 *
 * The guarantee is the WHATWG URL parser itself, used to extract ONLY the
 * `pathname + search + hash` from whatever was passed in — NEVER the
 * claimed origin. This makes it structurally impossible for the accepted
 * result to specify a different host, regardless of what the input looked
 * like: an absolute URL ("https://ithelpdesk.kinsen.gr/tickets"), a
 * protocol-relative one ("//evil.com"), or a backslash host-confusion trick
 * ("\\evil.com") all resolve, under this parser, to SOME origin plus a
 * pathname — and only that pathname (plus search/hash) is ever kept. A
 * malicious "https://evil.com/tickets" becomes the harmless same-origin
 * path "/tickets" (never a redirect to evil.com); a same-origin absolute
 * URL like the company suite actually sends resolves to that SAME correct
 * path instead of being rejected outright — which the previous, stricter
 * "reject any absolute URL" version of this function did, discarding the
 * suite's real intended destination every time. Percent-encoded slashes
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
 * Returns a safe, relative "pathname + search + hash" string — never the
 * raw input, and never anything that could carry a different host. Any
 * rejection (missing, malformed, resolves to a non-path scheme like
 * "javascript:", or targets a disallowed auth-loop path) resolves to
 * `fallback` (default: the Helpdesk dashboard), never throws.
 */
export function sanitizeInternalDestination(
  candidate: string | null | undefined,
  fallback: string = DEFAULT_SAFE_DESTINATION
): string {
  if (typeof candidate !== "string" || candidate.trim().length === 0) return fallback;

  let parsed: URL;
  try {
    parsed = new URL(candidate.trim(), RESOLUTION_BASE);
  } catch {
    return fallback;
  }

  // ONLY the path portion is ever used — see the module doc comment for why
  // this is safe regardless of what origin the input claimed.
  const normalized = `${parsed.pathname}${parsed.search}${parsed.hash}`;
  if (!normalized.startsWith("/") || normalized.startsWith("//")) return fallback;
  if (DISALLOWED_PREFIXES.some((prefix) => normalized === prefix.replace(/\/$/, "") || normalized.startsWith(prefix))) {
    return fallback;
  }

  return normalized;
}
