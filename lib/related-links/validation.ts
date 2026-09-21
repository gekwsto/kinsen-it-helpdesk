import { z } from "zod";

/**
 * Shared Related Link validation — imported by BOTH the client form
 * (components/related-links/entity-related-links.tsx) and the server
 * service/routes, so the two can never disagree. The server is still the
 * authority (the client can be bypassed); this just keeps the UX honest.
 *
 * Only http:// and https:// are accepted. Everything else — javascript:,
 * data:, file:, vbscript:, blob:, ftp:, mailto:, scheme-less text — is
 * rejected by allow-list (not a deny-list), so an unknown/future dangerous
 * scheme can never slip through. The URL is only ever stored and rendered
 * as an <a href>; the server never fetches it.
 */
export const RELATED_LINK_URL_MAX = 2048;
export const RELATED_LINK_TITLE_MAX = 250;

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);
// Whitespace or ASCII control characters anywhere inside a URL are never
// legitimate here and are a classic scheme-obfuscation vector ("java\tscript:").
const FORBIDDEN_URL_CHARS = /[\s\x00-\x1f\x7f]/;

/** Returns the URL string for storage (trimmed, otherwise untouched) or null if unsafe/malformed. */
export function parseSafeExternalUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > RELATED_LINK_URL_MAX) return null;
  if (FORBIDDEN_URL_CHARS.test(trimmed)) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) return null;
  if (!parsed.hostname) return null;
  return trimmed;
}

export const relatedLinkSchema = z.object({
  url: z
    .string({ required_error: "Link is required" })
    .trim()
    .min(1, "Link is required")
    .max(RELATED_LINK_URL_MAX, `Link must not exceed ${RELATED_LINK_URL_MAX} characters`)
    .refine((v) => parseSafeExternalUrl(v) !== null, "Enter a valid http:// or https:// link"),
  title: z
    .string({ required_error: "Title / Note is required" })
    .trim()
    .min(1, "Title / Note is required")
    .max(RELATED_LINK_TITLE_MAX, `Title / Note must not exceed ${RELATED_LINK_TITLE_MAX} characters`),
});

export type RelatedLinkInput = z.infer<typeof relatedLinkSchema>;

/** Hostname for compact display; falls back to the raw string if it somehow can't be parsed. */
export function relatedLinkHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
