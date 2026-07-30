import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import type { ExternalIntegration } from "@prisma/client";

// Recognizable prefix on every raw key — lets anyone spot a leaked
// TicketApp integration key in a log/diff at a glance, and doubles as the
// human-facing label shown next to apiKeyPrefix in the admin UI.
const KEY_PREFIX = "tkint_";
// 256 bits of entropy — unguessable, and far more than a slow KDF (bcrypt)
// would add any value protecting; this is a machine credential, not a
// human-memorable password, so a fast, keyed hash (HMAC) is the right tool,
// not bcrypt/argon2.
const SECRET_BYTES = 32;
// How much of the raw key is stored (unhashed) as apiKeyPrefix for O(1)
// indexed lookup — long enough to make prefix collisions practically
// impossible (it's also @unique in the schema, so a collision fails loudly
// at creation time rather than silently), short enough to leak no
// meaningful entropy about the secret portion.
const PREFIX_LOOKUP_LENGTH = KEY_PREFIX.length + 12;

/**
 * Distinct from a generic Error so callers (see verifyIntegrationKey's
 * consumers) can tell "this server is misconfigured" apart from an
 * unrelated unexpected failure, and respond with a controlled 5xx
 * (never a raw stack trace or an uncaught-exception crash) without
 * needing to string-match an error message.
 */
export class IntegrationPepperMissingError extends Error {
  constructor() {
    super(
      "INTEGRATION_KEY_PEPPER is not set. Refusing to hash/verify integration API keys without it — see .env.example."
    );
    this.name = "IntegrationPepperMissingError";
  }
}

function requireIntegrationKeyPepper(): string {
  const pepper = process.env.INTEGRATION_KEY_PEPPER;
  if (!pepper) {
    throw new IntegrationPepperMissingError();
  }
  return pepper;
}

/**
 * HMAC-SHA256(rawKey, pepper), hex-encoded. Deliberately not plain SHA-256:
 * the pepper is a server-only secret independent of the database, so a
 * stolen apiKeyHash value alone (e.g. via a DB dump) can never be reversed
 * or brute-forced back into a working raw key without also having the
 * pepper. Not bcrypt/argon2 either — the raw key already has 256 bits of
 * its own entropy, so a slow KDF designed to blunt human-password guessing
 * adds nothing here except latency on every request.
 */
export function hashIntegrationKey(rawKey: string): string {
  return crypto.createHmac("sha256", requireIntegrationKeyPepper()).update(rawKey).digest("hex");
}

/**
 * Generates a brand-new raw API key + its storable {prefix, hash}. The raw
 * value is returned exactly once by this function's caller chain (admin
 * create/rotate routes) and must never be persisted, logged, or returned
 * again after that single response.
 */
export function generateIntegrationKey(): { rawKey: string; keyPrefix: string; keyHash: string } {
  const secret = crypto.randomBytes(SECRET_BYTES).toString("base64url");
  const rawKey = `${KEY_PREFIX}${secret}`;
  return {
    rawKey,
    keyPrefix: rawKey.slice(0, PREFIX_LOOKUP_LENGTH),
    keyHash: hashIntegrationKey(rawKey),
  };
}

/**
 * generateIntegrationKey() wrapped with a bounded collision check against
 * the real apiKeyPrefix unique constraint. A collision is astronomically
 * unlikely (the prefix carries ~72 bits of the raw key's 256 bits of
 * entropy, growing more unlikely still as the birthday bound is computed
 * against however many integrations currently exist — negligible even at
 * huge scale), but a bounded retry costs nothing and turns "essentially
 * impossible" into "provably handled" rather than a hard failure an admin
 * would otherwise have to retry manually. The apiKeyPrefix DB unique
 * constraint remains the actual backstop regardless — this pre-check is
 * defense-in-depth, not a replacement for it.
 */
export async function generateUniqueIntegrationKey(
  maxAttempts = 5
): Promise<{ rawKey: string; keyPrefix: string; keyHash: string }> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const candidate = generateIntegrationKey();
    const collision = await prisma.externalIntegration.findUnique({
      where: { apiKeyPrefix: candidate.keyPrefix },
      select: { id: true },
    });
    if (!collision) return candidate;
  }
  throw new Error(`Failed to generate a unique integration API key prefix after ${maxAttempts} attempts.`);
}

export type VerifyIntegrationKeyResult =
  | { ok: true; integration: ExternalIntegration }
  | { ok: false; reason: "missing" | "malformed" | "invalid" | "disabled" };

/**
 * Verifies a raw `Authorization: Bearer <key>` value against the
 * ExternalIntegration table. Lookup is by the indexed, unique apiKeyPrefix
 * (never a full-table scan), then the candidate's hash is compared against
 * the stored hash with crypto.timingSafeEqual — constant-time, so a
 * response-time side channel can't be used to guess a valid hash byte by
 * byte. isActive is checked as a distinct outcome ("disabled") from an
 * unknown/wrong key ("invalid") only for the caller's own error-code
 * mapping (403 vs 401) — the comparison itself always runs either way, so
 * disabling a key is never observable via timing.
 */
export async function verifyIntegrationKey(rawToken: string | null | undefined): Promise<VerifyIntegrationKeyResult> {
  if (!rawToken) return { ok: false, reason: "missing" };
  if (!rawToken.startsWith(KEY_PREFIX) || rawToken.length < PREFIX_LOOKUP_LENGTH) {
    return { ok: false, reason: "malformed" };
  }

  const keyPrefix = rawToken.slice(0, PREFIX_LOOKUP_LENGTH);
  const integration = await prisma.externalIntegration.findUnique({ where: { apiKeyPrefix: keyPrefix } });
  if (!integration) return { ok: false, reason: "invalid" };

  const candidateHash = Buffer.from(hashIntegrationKey(rawToken), "hex");
  const storedHash = Buffer.from(integration.apiKeyHash, "hex");
  const matches =
    candidateHash.length === storedHash.length && crypto.timingSafeEqual(candidateHash, storedHash);
  if (!matches) return { ok: false, reason: "invalid" };

  if (!integration.isActive) return { ok: false, reason: "disabled" };

  // Fire-and-forget — never blocks/fails the request on a slow or failed
  // write, matching this codebase's existing non-blocking-update convention
  // (e.g. recalculateProjectRollup's fire-and-forget fan-out).
  prisma.externalIntegration
    .update({ where: { id: integration.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {});

  return { ok: true, integration };
}

/** Extracts the raw bearer token from a request's Authorization header, or null if absent/malformed. */
export function extractBearerToken(authorizationHeader: string | null): string | null {
  if (!authorizationHeader) return null;
  const match = authorizationHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}
