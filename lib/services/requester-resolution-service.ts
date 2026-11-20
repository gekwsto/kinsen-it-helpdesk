import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import type { User } from "@prisma/client";
import { normalizeEmail } from "@/lib/services/email-identity";
import { resolveDefaultGlobalRoleAssignment } from "@/lib/services/default-role-service";

/**
 * Finds an existing User by email (case-insensitively — trimmed + lowered
 * before lookup, so "User@Kinsen.gr" and "user@kinsen.gr" always resolve to
 * the same row) or creates a brand-new one with default standing: the
 * configured Default Global Role (lib/services/default-role-service.ts) if
 * an admin has set one, otherwise the pre-existing Role.USER/no-customRole
 * fallback — isActive: true, no department/authProvider override either
 * way.
 *
 * Deliberately narrow: never mutates an *existing* user's role, department,
 * customRoleId, or auth settings, and never reactivates one that's been
 * disabled (isActive: false) — an inactive user stays inactive even if a
 * new integration ticket names their email; the caller (see
 * ticket-creation-service.ts) still creates the Ticket against that
 * requesterId either way, matching how a WEB ticket from a since-deactivated
 * user is still visible/attributed rather than silently reassigned.
 *
 * Safe to call from any flow that resolves a "sender/requester by email"
 * (e.g. the existing inbound-email pipeline's own find-or-create in
 * pending-ticket-service.ts) without behavioral regression — it does
 * strictly less than an inline `prisma.user.create` with no normalization,
 * never more.
 *
 * Race-safe: two concurrent calls for the same not-yet-existing email can
 * both pass the initial findUnique before either creates the row — the
 * loser's create() then hits User.email's unique constraint (P2002) rather
 * than crashing the caller, and is treated the same as if its own
 * findUnique had found the row: re-fetch and return the winner's row.
 */
export async function resolveOrCreateRequester(rawEmail: string, rawName?: string | null): Promise<User> {
  const email = normalizeEmail(rawEmail);
  const name = rawName?.trim() || undefined;

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return existing;

  // No Microsoft mapping concept applies to an inbound-email-derived
  // requester — this resolves straight to the configured Default Global
  // Role (or the pre-existing role:USER/customRoleId:null fallback when
  // none is configured), same "no mapping tier here at all" reasoning as
  // organization-directory-sync-service.ts's own brand-new-user creation.
  const globalDefault = await resolveDefaultGlobalRoleAssignment();
  try {
    return await prisma.user.create({ data: { email, name, role: globalDefault.role, customRoleId: globalDefault.customRoleId } });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const winner = await prisma.user.findUnique({ where: { email } });
      if (winner) return winner;
    }
    throw error;
  }
}

/**
 * Thrown when a supplied Entra tenant id doesn't match this app's own
 * configured tenant (AUTH_MICROSOFT_ENTRA_ID_TENANT_ID — the SAME env var
 * that already pins lib/auth.config.ts's own Microsoft provider `issuer`,
 * never a second, separately-configured value). Mapped by the route to
 * `422 tenant_mismatch`.
 */
export class EntraTenantMismatchError extends Error {
  constructor() {
    super("The supplied requesterTenantId does not match this server's configured Entra tenant.");
    this.name = "EntraTenantMismatchError";
  }
}

/**
 * Thrown when a supplied Entra oid and email point at two DIFFERENT
 * existing identities — never silently resolved either way (could merge
 * two different people's ticket history under one account). Mapped by
 * the route to `409 requester_identity_conflict`.
 */
export class EntraIdentityConflictError extends Error {
  constructor(public reason: "oid_linked_to_different_email" | "email_linked_to_different_oid") {
    super(reason);
    this.name = "EntraIdentityConflictError";
  }
}

export interface EntraRequesterIdentity {
  /** The Entra `oid` claim — becomes the PRIMARY identity signal once present (see module doc comment on resolveOrCreateRequesterByEntraIdentity). */
  microsoftUserId: string;
  /** The Entra `tid` claim — validated against AUTH_MICROSOFT_ENTRA_ID_TENANT_ID before the oid is ever used for a lookup. */
  tenantId: string;
  rawEmail: string;
  rawName?: string | null;
}

/**
 * Entra-identity-aware sibling of resolveOrCreateRequester — used ONLY
 * when the integration ticket-creation request supplies
 * requesterMicrosoftUserId (see lib/validations.ts's
 * createIntegrationTicketSchema; requests without it are completely
 * unaffected and keep calling the plain email-only function above).
 *
 * REUSES THE EXISTING IDENTITY MODEL — no new table, no new column. This
 * is the SAME 4-step resolution order lib/services/organization-
 * directory-sync-service.ts's upsertOneDirectoryUser already implements
 * tenant-wide (oid first, email fallback-and-link, conflict detection,
 * else create) — re-implemented here narrowly for a single identity at
 * ticket-creation time, deliberately WITHOUT that function's
 * organizational-placement logic (company/department/jobTitle via Graph):
 * a ticket's department always comes from the INTEGRATION's own
 * configured binding, never from the requester's Entra department, so
 * none of that applies here, and this function makes ZERO Microsoft
 * Graph calls — it only reads/links data a prior login or the directory
 * sync already persisted locally.
 *
 * TRUST BOUNDARY: this function does not, and cannot, verify that `oid`
 * actually came from a real, currently-valid Entra token — that
 * verification happens (or must happen) entirely on the AI Agent
 * backend's own side, before it ever calls TicketApp. The ONLY thing
 * TicketApp authenticates here is the calling integration itself (its
 * Bearer API key, checked by the route before this function is ever
 * called). What THIS function adds on top of "the key is valid" is
 * exactly two things: (1) the tenant check below, and (2) never letting
 * an oid/email pair silently overwrite an existing, conflicting link.
 * Neither proves who sent the request; both close concrete, mechanical
 * gaps in what a request can get TicketApp to do.
 *
 * CONCURRENCY: every write below is race-safe against another request
 * resolving the same identity (or a conflicting one) at the same instant,
 * using Prisma's existing unique constraints (User.email,
 * User.microsoftUserId) as the actual backstop — never just an initial
 * read-then-write assumption. See the inline comments at each write.
 */
export async function resolveOrCreateRequesterByEntraIdentity(identity: EntraRequesterIdentity): Promise<User> {
  const configuredTenantId = process.env.AUTH_MICROSOFT_ENTRA_ID_TENANT_ID;
  if (!configuredTenantId || identity.tenantId !== configuredTenantId) {
    throw new EntraTenantMismatchError();
  }

  const email = normalizeEmail(identity.rawEmail);
  const name = identity.rawName?.trim() || undefined;
  const oid = identity.microsoftUserId;

  // 1. oid first — the primary anchor, exactly as organization-directory-
  // sync-service.ts's own identity resolution order.
  const byOid = await prisma.user.findUnique({ where: { microsoftUserId: oid } });
  if (byOid) {
    if (byOid.email !== email) {
      throw new EntraIdentityConflictError("oid_linked_to_different_email");
    }
    return byOid;
  }

  // 2. Not found by oid — fall back to email (same normalization as
  // resolveOrCreateRequester).
  const byEmail = await prisma.user.findUnique({ where: { email } });
  if (byEmail) {
    if (byEmail.microsoftUserId) {
      // Already linked, but to a DIFFERENT oid than this request
      // supplied — never silently reassigned (mirrors the directory
      // sync's identical rule).
      if (byEmail.microsoftUserId !== oid) {
        throw new EntraIdentityConflictError("email_linked_to_different_oid");
      }
      return byEmail; // already correctly linked — a normal repeat call.
    }

    // Link it — "found + updated, never duplicated", same as the
    // directory sync. updateMany's WHERE is NOT restricted to unique
    // fields (unlike update's), which is exactly what makes this a safe,
    // conditional write: it only actually links if microsoftUserId is
    // STILL null on this row at the moment the UPDATE runs, closing the
    // read-then-write race window a plain update()-after-findUnique would
    // leave open.
    try {
      const linkResult = await prisma.user.updateMany({
        where: { id: byEmail.id, microsoftUserId: null },
        data: { microsoftUserId: oid },
      });
      if (linkResult.count === 1) {
        const linked = await prisma.user.findUnique({ where: { id: byEmail.id } });
        if (linked) return linked;
      }
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        // This exact oid was linked to a DIFFERENT row by a concurrent
        // request in the window between our oid lookup (step 1) and this
        // write — resolve against whoever actually won, never retry
        // blindly.
        const winner = await prisma.user.findUnique({ where: { microsoftUserId: oid } });
        if (winner) return winner;
      }
      throw err;
    }

    // count was 0: a concurrent request already set SOME microsoftUserId
    // on this exact row between our read and this write. Re-check
    // against the row's real, current state rather than assuming either
    // outcome.
    const refetched = await prisma.user.findUnique({ where: { id: byEmail.id } });
    if (refetched?.microsoftUserId === oid) return refetched; // the winner linked the SAME oid we wanted — fine.
    throw new EntraIdentityConflictError("email_linked_to_different_oid");
  }

  // 3. Neither oid nor email matched anything locally — create fresh,
  // same default-role/active behavior as resolveOrCreateRequester's own
  // creation path, with microsoftUserId set from the start.
  const globalDefault = await resolveDefaultGlobalRoleAssignment();
  try {
    return await prisma.user.create({
      data: { email, name, microsoftUserId: oid, role: globalDefault.role, customRoleId: globalDefault.customRoleId },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      // Lost a race on EITHER the email OR the microsoftUserId unique
      // constraint (a concurrent call for the exact same identity, or a
      // genuinely conflicting one) — re-resolve from scratch against
      // whatever actually committed, rather than guessing which it was.
      const byOidAfter = await prisma.user.findUnique({ where: { microsoftUserId: oid } });
      if (byOidAfter) {
        if (byOidAfter.email !== email) throw new EntraIdentityConflictError("oid_linked_to_different_email");
        return byOidAfter;
      }
      const byEmailAfter = await prisma.user.findUnique({ where: { email } });
      if (byEmailAfter) {
        if (byEmailAfter.microsoftUserId && byEmailAfter.microsoftUserId !== oid) {
          throw new EntraIdentityConflictError("email_linked_to_different_oid");
        }
        return byEmailAfter;
      }
    }
    throw error;
  }
}
