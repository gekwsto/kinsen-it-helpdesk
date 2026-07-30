import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import type { User } from "@prisma/client";
import { normalizeEmail } from "@/lib/services/email-identity";

/**
 * Finds an existing User by email (case-insensitively — trimmed + lowered
 * before lookup, so "User@Kinsen.gr" and "user@kinsen.gr" always resolve to
 * the same row) or creates a brand-new one with default, unprivileged
 * standing (Role.USER via the schema default, isActive: true, no
 * department/customRole/authProvider override).
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

  try {
    return await prisma.user.create({ data: { email, name } });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const winner = await prisma.user.findUnique({ where: { email } });
      if (winner) return winner;
    }
    throw error;
  }
}
