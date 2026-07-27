/**
 * Delegated-token Microsoft Graph profile-photo sync — the ONE place
 * User.image is ever written from Microsoft. Called from
 * handleMicrosoftJwtSignIn (lib/services/microsoft-department-sync-service.ts)
 * for EVERY Microsoft sign-in, both a brand-new user's first login and an
 * already-existing user's Nth login — there is no separate "create" vs
 * "existing" branch here, because by the time this runs, Auth.js has already
 * resolved (created-or-linked) the local user; this function only needs the
 * resulting userId, not which branch produced it.
 *
 * Root cause of the original bug (documented here since this is the fix):
 * the built-in `next-auth`/`@auth/core` MicrosoftEntraID provider has its
 * OWN implicit photo fetch baked into its `profile()` callback (GET
 * /me/photos/48x48/$value, delegated token) — its result becomes the OAuth
 * `user.image` field. Auth.js's adapter only writes that `image` field on
 * `createUser` (brand-new user); on every other path (an already-linked
 * returning user, or an email-matched existing user), Auth.js's own
 * `handleLoginOrRegister` never calls `updateUser` with the fresh profile at
 * all — so the freshly-fetched photo was silently discarded for every
 * existing user, on every login, forever. lib/auth.config.ts now overrides
 * that provider's `profile()` to skip the implicit fetch entirely (see the
 * comment there) — this service is the single, explicit, controlled
 * replacement, called uniformly after user resolution instead.
 *
 * Endpoint: GET https://graph.microsoft.com/v1.0/me/photos/48x48/$value
 * (same endpoint + size the built-in provider used, for visual parity with
 * existing users' photos). Permission: delegated `User.Read` — the SAME
 * scope already requested for login (lib/auth.config.ts) and already used
 * for the /me profile fetch (microsoft-graph-profile-service.ts). No
 * additional Graph permission, no admin consent, needed for this endpoint —
 * a user reading their own photo via their own delegated token is covered
 * by User.Read, exactly like reading their own department/jobTitle is.
 */
import { prisma } from "@/lib/prisma";

const GRAPH_PHOTO_URL = "https://graph.microsoft.com/v1.0/me/photos/48x48/$value";
const REQUEST_TIMEOUT_MS = 5000;

export type ProfilePhotoSyncReason =
  | "synced"
  | "unchanged"
  | "not_modified"
  | "protected_manual"
  | "no_token"
  | "not_found"
  | "unauthorized"
  | "forbidden"
  | "rate_limited"
  | "server_error"
  | "network_error"
  | "malformed_response"
  | "superseded";

export type ProfilePhotoSyncResult =
  | { ok: true; updated: boolean; reason: ProfilePhotoSyncReason }
  | { ok: false; reason: ProfilePhotoSyncReason; status?: number };

export interface SyncMicrosoftProfilePhotoParams {
  userId: string;
  /** Delegated access token from this sign-in's OAuth exchange — never persisted, never logged. */
  accessToken?: string;
}

/**
 * Fetches the signed-in user's Microsoft photo and updates User.image, but
 * ONLY when it's safe to do so — never overwrites a manually-set avatar,
 * never wipes an existing photo on a 404 or transient Graph failure, and
 * never lets an older/slower request clobber a newer photo already written
 * by a concurrent login (see the fetchedAt guard below). Never throws — the
 * caller (the jwt callback, via handleMicrosoftJwtSignIn) must be able to
 * complete sign-in regardless of what happens here.
 */
export async function syncMicrosoftProfilePhoto(
  params: SyncMicrosoftProfilePhotoParams
): Promise<ProfilePhotoSyncResult> {
  const { userId, accessToken } = params;

  if (!accessToken) return { ok: false, reason: "no_token" };

  const current = await prisma.user.findUnique({
    where: { id: userId },
    select: { avatarSource: true, microsoftPhotoEtag: true },
  });
  if (!current) return { ok: false, reason: "not_found" };

  // A manually-set avatar (or one set by any future upload feature) is
  // never touched — checked BEFORE making any Graph call at all, so a
  // protected user doesn't even cost an extra API round-trip.
  if (current.avatarSource === "MANUAL") {
    return { ok: true, updated: false, reason: "protected_manual" };
  }

  let response: Response;
  try {
    const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}` };
    if (current.microsoftPhotoEtag) headers["If-None-Match"] = current.microsoftPhotoEtag;
    response = await fetch(GRAPH_PHOTO_URL, {
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    console.warn("[microsoft-profile-photo] Graph request failed, keeping existing photo", {
      userId,
      reason: "network_error",
      message: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, reason: "network_error" };
  }

  // ETag matched — Graph confirms the photo hasn't changed. Nothing to write.
  if (response.status === 304) {
    return { ok: true, updated: false, reason: "not_modified" };
  }

  // No Microsoft photo (removed, never set, or this account type has none) —
  // per policy, an existing local photo is always kept; nothing is written
  // either way, so this is a safe no-op, never a deletion trigger.
  if (response.status === 404) {
    return { ok: true, updated: false, reason: "not_found" };
  }

  if (response.status === 401) return { ok: false, reason: "unauthorized", status: 401 };
  if (response.status === 403) return { ok: false, reason: "forbidden", status: 403 };
  if (response.status === 429) return { ok: false, reason: "rate_limited", status: 429 };
  if (!response.ok) return { ok: false, reason: "server_error", status: response.status };

  const newEtag = response.headers.get("etag");

  // Defensive second check in case Graph ever returns 200 with unchanged
  // content instead of honoring If-None-Match (e.g. proxy stripping
  // conditional headers) — avoids a redundant re-download/re-write either way.
  if (newEtag && current.microsoftPhotoEtag && newEtag === current.microsoftPhotoEtag) {
    return { ok: true, updated: false, reason: "unchanged" };
  }

  let dataUri: string;
  try {
    const contentType = response.headers.get("content-type") || "image/jpeg";
    const buffer = await response.arrayBuffer();
    const base64 = Buffer.from(buffer).toString("base64");
    dataUri = `data:${contentType};base64,${base64}`;
  } catch {
    return { ok: false, reason: "malformed_response" };
  }

  const fetchedAt = new Date();

  // Atomic, conditional update: only ever moves a row FROM (no avatarSource
  // set, or already MICROSOFT) — a MANUAL row can never reach here (checked
  // above), this is defense in depth against a concurrent change between the
  // read above and this write. The microsoftPhotoUpdatedAt comparison is the
  // race guard: a request that fetched its photo BEFORE another, slower
  // request already finished writing a newer one, can never overwrite it —
  // whichever fetch has the latest fetchedAt always wins, regardless of
  // which database write happens to land first or last.
  const result = await prisma.user.updateMany({
    where: {
      id: userId,
      OR: [{ avatarSource: null }, { avatarSource: "MICROSOFT" }],
      AND: [{ OR: [{ microsoftPhotoUpdatedAt: null }, { microsoftPhotoUpdatedAt: { lt: fetchedAt } }] }],
    },
    data: {
      image: dataUri,
      avatarSource: "MICROSOFT",
      microsoftPhotoEtag: newEtag,
      microsoftPhotoUpdatedAt: fetchedAt,
    },
  });

  if (result.count === 0) {
    // Either a MANUAL avatar was set in the meantime, or a newer concurrent
    // sync already won — either way, this request must not report success
    // as if it had written anything.
    return { ok: true, updated: false, reason: "superseded" };
  }

  console.log("[microsoft-profile-photo] Synced Microsoft profile photo", {
    userId,
    updated: true,
  });
  return { ok: true, updated: true, reason: "synced" };
}
