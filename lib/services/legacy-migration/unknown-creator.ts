/**
 * The dedicated placeholder requester for legacy tickets with NO creator at
 * all (dbo.Tickets.User IS NULL — expected count: 2). Ticket.requesterId is
 * NOT NULL in the target schema, so some value is unavoidable; the
 * migration brief explicitly forbids silently assigning these to "System
 * Administrator" — this account is a distinct, clearly-labeled,
 * non-privileged, `isActive: false` (can never sign in) placeholder
 * instead, created once and reused via the SAME normalized-email
 * reconciliation invariant every other target user goes through, and
 * assigned the CURRENT configured Default Global Role
 * (lib/services/default-role-service.ts) — never a hardcoded Role.USER.
 */
import type { PrismaClient } from "@prisma/client";
import { normalizeEmail } from "@/lib/services/email-identity";
import { resolveDefaultGlobalRoleAssignment } from "@/lib/services/default-role-service";

export const UNKNOWN_CREATOR_EMAIL = normalizeEmail("legacy-unknown-creator@migration.invalid");
export const UNKNOWN_CREATOR_NAME = "Legacy Unknown Creator (Migration Placeholder)";

export async function ensureUnknownCreatorPlaceholder(db: PrismaClient, dryRun: boolean): Promise<string> {
  const existing = await db.user.findUnique({ where: { email: UNKNOWN_CREATOR_EMAIL }, select: { id: true } });
  if (existing) return existing.id;
  if (dryRun) return "dry-run:unknown-creator-placeholder";

  const defaultGlobalRole = await resolveDefaultGlobalRoleAssignment();
  const created = await db.user.create({
    data: {
      email: UNKNOWN_CREATOR_EMAIL,
      name: UNKNOWN_CREATOR_NAME,
      role: defaultGlobalRole.role,
      customRoleId: defaultGlobalRole.customRoleId,
      isActive: false,
    },
    select: { id: true },
  });
  return created.id;
}
