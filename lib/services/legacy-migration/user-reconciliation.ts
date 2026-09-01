/**
 * Legacy user identity resolution + reconciliation for the one-time
 * TicketApp migration.
 *
 * Canonical identity chain (per the migration brief's proven facts):
 *   legacy dbo.Users.UserName
 *     -> security.ApplicationUsers.UserName (join key)
 *     -> ApplicationUsers.Email
 *     -> lib/services/email-identity.ts's normalizeEmail() (the SAME
 *        normalization every other User-creation path in this app already
 *        uses, and the same normalization Microsoft sign-in's
 *        withNormalizedEmail adapter wrapper applies at login — see
 *        lib/auth.ts)
 *     -> target User.id
 *
 * Matching is ALWAYS by UserName (case-insensitive key join) or by
 * normalized email — NEVER by display name, and never fuzzy. Two source
 * UserNames whose emails normalize to the same value are flagged as a
 * duplicate and reported, never silently merged or silently split into two
 * target users (see reconcileLegacyUsers's duplicateNormalizedEmails).
 */
import type { PrismaClient, Prisma, Role } from "@prisma/client";
import { normalizeEmail } from "@/lib/services/email-identity";
import type { LegacyUserRow, LegacyApplicationUserRow } from "@/lib/services/legacy-migration/sql-source-client";
import { getLedgerEntry, recordLedgerSuccess } from "@/lib/services/legacy-migration/ledger";

type Db = PrismaClient | Prisma.TransactionClient;

export interface LegacyIdentity {
  userName: string;
  legacyUserId: number;
  rawEmail: string | null;
  normalizedEmail: string | null;
  displayName: string | null;
}

export interface BuildIdentitiesResult {
  identities: LegacyIdentity[];
  /** dbo.Users rows with no matching security.ApplicationUsers row at all (join miss) — reported, not silently dropped. */
  usersWithNoApplicationUserMatch: LegacyUserRow[];
  /** The ApplicationUsers row with no dbo.Users counterpart (the proven "Pavlos Chatzisavvas" extra row) — informational only, never migrated as a business user unless explicitly requested for historical reporting. */
  applicationUsersWithNoBusinessUserRow: LegacyApplicationUserRow[];
}

/** Pure join — no DB, no network. Case-insensitive UserName key match (a legitimate exact-identity join on what's meant to be the same literal username, not a fuzzy/display-name match). */
export function buildLegacyIdentities(users: LegacyUserRow[], appUsers: LegacyApplicationUserRow[]): BuildIdentitiesResult {
  const appUsersByUserName = new Map<string, LegacyApplicationUserRow>();
  for (const au of appUsers) {
    appUsersByUserName.set(au.UserName.trim().toLowerCase(), au);
  }

  const identities: LegacyIdentity[] = [];
  const usersWithNoApplicationUserMatch: LegacyUserRow[] = [];
  const matchedUserNames = new Set<string>();

  for (const u of users) {
    const key = u.UserName.trim().toLowerCase();
    const au = appUsersByUserName.get(key);
    if (!au) {
      usersWithNoApplicationUserMatch.push(u);
      continue;
    }
    matchedUserNames.add(key);
    identities.push({
      userName: u.UserName,
      legacyUserId: u.Id,
      rawEmail: au.Email,
      normalizedEmail: au.Email ? normalizeEmail(au.Email) : null,
      displayName: au.Name?.trim() || null,
    });
  }

  const applicationUsersWithNoBusinessUserRow = appUsers.filter((au) => !matchedUserNames.has(au.UserName.trim().toLowerCase()));

  return { identities, usersWithNoApplicationUserMatch, applicationUsersWithNoBusinessUserRow };
}

export interface DuplicateNormalizedEmailGroup {
  normalizedEmail: string;
  userNames: string[];
}

/** Detected/reported BEFORE any write — never merged or silently split. */
export function findDuplicateNormalizedEmails(identities: LegacyIdentity[]): DuplicateNormalizedEmailGroup[] {
  const byEmail = new Map<string, string[]>();
  for (const id of identities) {
    if (!id.normalizedEmail) continue;
    const list = byEmail.get(id.normalizedEmail);
    if (list) list.push(id.userName);
    else byEmail.set(id.normalizedEmail, [id.userName]);
  }
  return [...byEmail.entries()]
    .filter(([, userNames]) => userNames.length > 1)
    .map(([normalizedEmail, userNames]) => ({ normalizedEmail, userNames }));
}

export interface DefaultGlobalRoleAssignment {
  role: Role;
  customRoleId: string | null;
}

export interface UnresolvedUser {
  userName: string;
  reason: string;
}

export interface ReconcileUsersResult {
  usernameToUserId: Map<string, string>;
  reused: number;
  created: number;
  unresolved: UnresolvedUser[];
  duplicateNormalizedEmails: DuplicateNormalizedEmailGroup[];
}

/**
 * Reconciliation priority (per the migration brief):
 *   1. Ledger hit (this exact legacy UserName already migrated in a prior
 *      run) -> reuse targetId, no DB lookup needed.
 *   2. An existing target User already owns this normalized email
 *      (including a pre-existing admin account) -> reuse that EXACT
 *      User.id — never create a second row for the same identity.
 *   3. Otherwise -> create one new target user, using the CURRENT
 *      configured Default Global Role (resolveDefaultGlobalRoleAssignment
 *      in lib/services/default-role-service.ts — resolved ONCE by the
 *      caller and passed in here, never re-derived per user, and never a
 *      hardcoded Role.USER/customRoleId fallback of this module's own).
 *
 * A duplicate normalized email across two different source UserNames is
 * detected up front (findDuplicateNormalizedEmails) and reported; this
 * function still resolves each duplicate UserName to the SAME target
 * User.id (whichever the email itself already reconciles to) rather than
 * either failing the whole run or fabricating two rows for one email — the
 * database's own case-insensitive unique index on email makes a second row
 * impossible even if this logic had a bug, but relying on that as the
 * primary safeguard would surface a 500 mid-run instead of a clean report.
 */
export async function reconcileLegacyUsers(
  db: Db,
  identities: LegacyIdentity[],
  defaultGlobalRole: DefaultGlobalRoleAssignment,
  dryRun: boolean
): Promise<ReconcileUsersResult> {
  const usernameToUserId = new Map<string, string>();
  const unresolved: UnresolvedUser[] = [];
  let reused = 0;
  let created = 0;

  const duplicateNormalizedEmails = findDuplicateNormalizedEmails(identities);
  const resolvedEmailToUserId = new Map<string, string>();

  for (const identity of identities) {
    if (!identity.normalizedEmail) {
      unresolved.push({ userName: identity.userName, reason: "No email on the matching security.ApplicationUsers row." });
      continue;
    }

    // Priority 1: ledger.
    const ledgerEntry = await getLedgerEntry(db, "USER", identity.userName);
    if (ledgerEntry?.status === "SUCCEEDED" && ledgerEntry.targetId) {
      usernameToUserId.set(identity.userName, ledgerEntry.targetId);
      resolvedEmailToUserId.set(identity.normalizedEmail, ledgerEntry.targetId);
      reused++;
      continue;
    }

    // A duplicate email already resolved earlier in THIS SAME run.
    const alreadyResolved = resolvedEmailToUserId.get(identity.normalizedEmail);
    if (alreadyResolved) {
      usernameToUserId.set(identity.userName, alreadyResolved);
      if (!dryRun) await recordLedgerSuccess(db, "USER", identity.userName, alreadyResolved);
      reused++;
      continue;
    }

    // Priority 2: an existing target user already owns this email.
    const existing = await db.user.findUnique({ where: { email: identity.normalizedEmail }, select: { id: true } });
    if (existing) {
      usernameToUserId.set(identity.userName, existing.id);
      resolvedEmailToUserId.set(identity.normalizedEmail, existing.id);
      if (!dryRun) await recordLedgerSuccess(db, "USER", identity.userName, existing.id);
      reused++;
      continue;
    }

    // Priority 3: create.
    if (dryRun) {
      // Dry run never writes — record a synthetic placeholder id so
      // downstream dry-run phases (tickets/comments referencing this
      // "would-be" user) can still validate their own logic end to end.
      const placeholderId = `dry-run:${identity.userName}`;
      usernameToUserId.set(identity.userName, placeholderId);
      resolvedEmailToUserId.set(identity.normalizedEmail, placeholderId);
      created++;
      continue;
    }

    const createdUser = await db.user.create({
      data: {
        email: identity.normalizedEmail,
        name: identity.displayName ?? identity.userName,
        role: defaultGlobalRole.role,
        customRoleId: defaultGlobalRole.customRoleId,
        isActive: true,
      },
      select: { id: true },
    });
    usernameToUserId.set(identity.userName, createdUser.id);
    resolvedEmailToUserId.set(identity.normalizedEmail, createdUser.id);
    await recordLedgerSuccess(db, "USER", identity.userName, createdUser.id);
    created++;
  }

  return { usernameToUserId, reused, created, unresolved, duplicateNormalizedEmails };
}
