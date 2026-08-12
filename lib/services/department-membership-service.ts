import { prisma } from "@/lib/prisma";
import type { DepartmentMembership, Prisma } from "@prisma/client";
import { DepartmentRole, MembershipSource, RoleScope } from "@prisma/client";
import type { DepartmentMembershipView, ResolvedMembership } from "@/types/department";

/** A plain PrismaClient or an in-flight $transaction callback client — lets a caller opt a write into its own transaction without every service function needing its own. */
type Db = typeof prisma | Prisma.TransactionClient;

const membershipInclude = {
  department: {
    select: { id: true, name: true, slug: true, description: true, isActive: true, businessUnitId: true },
  },
} as const;

type MembershipWithDepartment = DepartmentMembership & { department: DepartmentMembershipView["department"] };

function toView(m: MembershipWithDepartment): DepartmentMembershipView {
  return {
    id: m.id,
    userId: m.userId,
    departmentId: m.departmentId,
    role: m.role,
    customRoleId: m.customRoleId,
    source: m.source,
    isPrimary: m.isPrimary,
    isActive: m.isActive,
    department: m.department,
  };
}

/** Active memberships in active departments only — the set a user can actually act within. */
export async function getUserDepartmentMemberships(userId: string): Promise<DepartmentMembershipView[]> {
  const rows = await prisma.departmentMembership.findMany({
    where: { userId, isActive: true, department: { isActive: true } },
    include: membershipInclude,
    orderBy: { createdAt: "asc" },
  });
  return rows.map(toView);
}

const memberUserSelect = { id: true, name: true, email: true, image: true } as const;

export interface DepartmentMembershipAdminView {
  id: string;
  userId: string;
  departmentId: string;
  role: DepartmentRole;
  customRoleId: string | null;
  customRole: { id: string; key: string; name: string; isActive: boolean } | null;
  source: MembershipSource;
  isPrimary: boolean;
  isActive: boolean;
  user: { id: string; name: string | null; email: string; image: string | null };
}

/**
 * All memberships (active *and* inactive) for a department, with the member's
 * user info — an admin visibility view, not an authorization check, so
 * unlike getUserDepartmentMemberships this deliberately does NOT filter
 * isActive: an admin needs to see revoked rows to reactivate them.
 */
export async function getDepartmentMemberships(departmentId: string): Promise<DepartmentMembershipAdminView[]> {
  const rows = await prisma.departmentMembership.findMany({
    where: { departmentId },
    include: {
      user: { select: memberUserSelect },
      customRole: { select: { id: true, key: true, name: true, isActive: true } },
    },
    orderBy: [{ isActive: "desc" }, { createdAt: "asc" }],
  });
  return rows.map((m) => ({
    id: m.id,
    userId: m.userId,
    departmentId: m.departmentId,
    role: m.role,
    customRoleId: m.customRoleId,
    customRole: m.customRole,
    source: m.source,
    isPrimary: m.isPrimary,
    isActive: m.isActive,
    user: m.user,
  }));
}

export async function getMembership(userId: string, departmentId: string): Promise<DepartmentMembershipView | null> {
  // findFirst (not findUnique) because we need to additionally filter on the
  // related Department's isActive — findUnique only accepts the unique key
  // fields themselves, it can't filter on a relation.
  const row = await prisma.departmentMembership.findFirst({
    where: { userId, departmentId, isActive: true, department: { isActive: true } },
    include: membershipInclude,
  });
  if (!row) return null;
  return toView(row);
}

/**
 * Reconciles a user's SECONDARY DepartmentMembership rows with a freshly-
 * resolved set (from Microsoft claims, see microsoft-mapping-service) —
 * i.e. explicit MicrosoftDepartmentMapping matches (group/app-role/job-title/
 * profile-department), independent of the multi-company organizational
 * PRIMARY placement, which is setPrimaryDepartmentMembership's exclusive job
 * (see its own header comment). This function never creates, updates, or
 * revokes an `isPrimary: true` row — primary designation is out of scope
 * here entirely, so it can never fight with setPrimaryDepartmentMembership's
 * own decisions about the same user (both are commonly called back-to-back
 * for the same sync run, e.g. organization-directory-sync-service.ts,
 * microsoft-department-sync-service.ts).
 *
 * Rules (see the login-sync edge cases in the architecture plan):
 * - A MANUAL row (admin override) is never modified or removed here — it
 *   survives regardless of what the resolved set says.
 * - A row currently flagged isPrimary is never modified or removed here
 *   either, regardless of source — it survives untouched, full stop.
 * - Resolved tuples are upserted by [userId, departmentId]; an existing
 *   non-MANUAL, non-primary row gets its role/source updated (a
 *   "promotion" is an update, not a new row).
 * - An existing non-MANUAL, non-primary, currently-active membership whose
 *   department is no longer in the resolved set is soft-revoked
 *   (isActive: false), never deleted — preserves history and anything
 *   referencing the user.
 * - If exactly one active membership exists afterward and none is flagged
 *   primary, it's promoted to primary — a fallback for callers with no
 *   separate primary-placement signal of their own; harmless for callers
 *   that also call setPrimaryDepartmentMembership, since that function
 *   corrects the final primary regardless of what this fallback did.
 */
export async function syncDepartmentMemberships(
  userId: string,
  resolved: ResolvedMembership[]
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const existing = await tx.departmentMembership.findMany({ where: { userId } });
    const existingByDept = new Map(existing.map((m) => [m.departmentId, m]));
    const resolvedDeptIds = new Set(resolved.map((r) => r.departmentId));

    for (const r of resolved) {
      const current = existingByDept.get(r.departmentId);
      if (current?.source === MembershipSource.MANUAL) continue; // never overwrite a manual override
      if (current?.isPrimary) continue; // primary rows are setPrimaryDepartmentMembership's exclusive concern

      if (current) {
        await tx.departmentMembership.update({
          where: { id: current.id },
          data: { role: r.role, customRoleId: r.customRoleId, source: r.source, isActive: true },
        });
      } else {
        await tx.departmentMembership.create({
          data: { userId, departmentId: r.departmentId, role: r.role, customRoleId: r.customRoleId, source: r.source },
        });
      }
    }

    // Soft-revoke non-MANUAL, non-primary memberships whose source claim disappeared.
    for (const current of existing) {
      if (current.source === MembershipSource.MANUAL) continue;
      if (current.isPrimary) continue; // never revoked from here — see header comment
      if (!resolvedDeptIds.has(current.departmentId) && current.isActive) {
        await tx.departmentMembership.update({
          where: { id: current.id },
          data: { isActive: false },
        });
      }
    }

    const active = await tx.departmentMembership.findMany({ where: { userId, isActive: true } });
    if (active.length === 1 && !active[0].isPrimary) {
      await tx.departmentMembership.update({
        where: { id: active[0].id },
        data: { isPrimary: true },
      });
    }
  });
}

export type DepartmentRoleSelection = { role: DepartmentRole; customRoleId?: null } | { role?: null; customRoleId: string };

// Thrown by grantManualMembership so callers (the members-add API, the
// admin user-edit modal's membership editor) can surface a specific,
// actionable error instead of a generic 500.
export class DepartmentRoleAssignmentError extends Error {
  constructor(
    public code: "ROLE_NOT_FOUND" | "ROLE_WRONG_SCOPE" | "ROLE_INACTIVE"
  ) {
    super(code);
    this.name = "DepartmentRoleAssignmentError";
  }
}

/**
 * Never trusts a submitted role selection at face value — mirrors
 * lib/services/microsoft-mapping-service.ts's
 * assertGlobalCustomRoleEligible/assertDepartmentCustomRoleEligible (same
 * reasoning, department-membership-scoped): a GLOBAL-scope custom role id
 * is rejected outright, and a role that is currently `isActive: false`
 * (whether built-in or custom) is rejected for a genuinely NEW assignment.
 *
 * "Genuinely new" is the key distinction: if `current` already holds this
 * EXACT role/customRoleId, the check is skipped entirely — reactivating a
 * revoked membership back to its own historical role, or re-saving a
 * membership without actually changing its role, must never be blocked
 * merely because that role was disabled sometime after the fact. This is
 * what lets an admin still read/manage a user already on a disabled role
 * without corrupting the existing assignment.
 *
 * A built-in role with no mirrored CustomRole row at all (should be
 * unreachable once every environment has run the
 * 20260812091426_backfill_builtin_department_roles migration) fails OPEN,
 * not closed — the DepartmentRole enum value itself remains the ultimate
 * identity for a genuinely built-in role; this only blocks a role that is
 * POSITIVELY KNOWN to be disabled, never one this lookup simply couldn't find.
 */
async function assertDepartmentRoleAssignable(
  selection: DepartmentRoleSelection,
  current: { role: DepartmentRole; customRoleId: string | null } | null,
  db: Db
): Promise<void> {
  if (selection.customRoleId) {
    if (current?.customRoleId === selection.customRoleId) return; // unchanged — never blocked
    const role = await db.customRole.findUnique({ where: { id: selection.customRoleId } });
    if (!role) throw new DepartmentRoleAssignmentError("ROLE_NOT_FOUND");
    if (role.scope === RoleScope.GLOBAL) throw new DepartmentRoleAssignmentError("ROLE_WRONG_SCOPE");
    if (!role.isActive) throw new DepartmentRoleAssignmentError("ROLE_INACTIVE");
    return;
  }

  const targetRole = selection.role!;
  if (!current?.customRoleId && current?.role === targetRole) return; // unchanged — never blocked
  const role = await db.customRole.findUnique({ where: { key: targetRole } });
  if (role && !role.isActive) throw new DepartmentRoleAssignmentError("ROLE_INACTIVE");
}

/**
 * Grants (or updates, upsert-by-[userId,departmentId]) a manual membership —
 * either a built-in DepartmentRole or a custom department role
 * (customRoleId, see getDepartmentRoleOptions in
 * lib/services/department-role-options-service.ts). When a custom role is
 * selected, `role` still needs a value at the DB level (required column) so
 * it's set to the least-privilege placeholder VIEWER — it is never read for
 * permission purposes once customRoleId is set (see hasDepartmentPermission).
 */
export async function grantManualMembership(
  userId: string,
  departmentId: string,
  selection: DepartmentRoleSelection,
  db: Db = prisma
): Promise<DepartmentMembership> {
  const existing = await db.departmentMembership.findUnique({
    where: { userId_departmentId: { userId, departmentId } },
    select: { role: true, customRoleId: true },
  });
  await assertDepartmentRoleAssignable(selection, existing, db);

  const role = selection.customRoleId ? DepartmentRole.VIEWER : selection.role!;
  const customRoleId = selection.customRoleId ?? null;
  return db.departmentMembership.upsert({
    where: { userId_departmentId: { userId, departmentId } },
    update: { role, customRoleId, source: MembershipSource.MANUAL, isActive: true },
    create: { userId, departmentId, role, customRoleId, source: MembershipSource.MANUAL },
  });
}

/** Soft-revoke — never deletes, so ticket/project history referencing the user is unaffected. */
export async function revokeMembership(id: string): Promise<DepartmentMembership> {
  return prisma.departmentMembership.update({ where: { id }, data: { isActive: false } });
}

/**
 * Ensures an active DepartmentMembership exists for (userId, departmentId).
 * Pure row-level upsert — does NOT touch `isPrimary` or `User.departmentId`;
 * see setPrimaryDepartmentMembership below for the atomic operation that
 * manages those too. Kept as its own composable building block (accepts an
 * optional `db` so a caller can fold it into a larger transaction) because
 * its "never clobber an already-active row's source/role unless something
 * actually needs to change" behavior is reused as-is by
 * setPrimaryDepartmentMembership:
 *  - no row yet -> create it, source MANUAL, role = desiredRole.
 *  - inactive row -> reactivate (isActive:true, source MANUAL) — reactivating
 *    is itself a deliberate decision, matching the existing "Reactivate"
 *    semantics elsewhere in this admin surface.
 *  - active row already on a custom department role (customRoleId set) ->
 *    left untouched entirely; this passive sync never downgrades a custom
 *    role assignment to a plain enum role.
 *  - active row, role already matches the desired role -> untouched (no-op).
 *  - active row, role differs -> role updated and source becomes MANUAL,
 *    mirroring the existing "changing this marks it as manual override"
 *    rule already applied to direct role edits.
 */
export async function ensurePrimaryDepartmentMembership(
  userId: string,
  departmentId: string,
  desiredRole: DepartmentRole,
  db: Db = prisma
): Promise<DepartmentMembership> {
  const existing = await db.departmentMembership.findUnique({
    where: { userId_departmentId: { userId, departmentId } },
  });

  if (!existing) {
    return db.departmentMembership.create({
      data: { userId, departmentId, role: desiredRole, customRoleId: null, source: MembershipSource.MANUAL, isActive: true },
    });
  }

  if (!existing.isActive) {
    return db.departmentMembership.update({
      where: { id: existing.id },
      data: { isActive: true, source: MembershipSource.MANUAL, role: desiredRole, customRoleId: null },
    });
  }

  if (existing.customRoleId) return existing;
  if (existing.role === desiredRole) return existing;

  return db.departmentMembership.update({
    where: { id: existing.id },
    data: { role: desiredRole, source: MembershipSource.MANUAL },
  });
}

export type SetPrimaryDepartmentMembershipOutcome = "unchanged" | "aligned" | "switched" | "blocked_manual_primary_protected";

export interface SetPrimaryDepartmentMembershipOptions {
  /** Role to apply to the target row — ignored (existing value preserved) for an existing MANUAL-source or custom-role row, same protection as ensurePrimaryDepartmentMembership. */
  role: DepartmentRole;
  /**
   * Microsoft-sourced calls ONLY (organization-directory-sync-service.ts,
   * microsoft-department-sync-service.ts): when the CURRENT primary is being
   * replaced and its source is itself Microsoft-derived (not MANUAL), fully
   * deactivate it (isActive:false) instead of just demoting it to a
   * secondary membership — "Microsoft organizational placement δεν πρέπει
   * να αφήνει πίσω παλιό Microsoft-granted department access χωρίς λόγο."
   * Admin-driven (source: MANUAL) calls must never pass this — an explicit
   * admin primary change should never silently revoke the old department's
   * access; the old primary is always just demoted to isPrimary:false,
   * isActive unchanged, for a MANUAL call. Defaults to false.
   */
  deactivateObsoleteMicrosoftPrimary?: boolean;
}

export interface SetPrimaryDepartmentMembershipResult {
  outcome: SetPrimaryDepartmentMembershipOutcome;
  /** The membership that IS (or remains) primary after this call — for "blocked_manual_primary_protected", this is the untouched, MANUAL-protected existing primary. */
  primaryMembership: DepartmentMembership;
  previousPrimaryDepartmentId: string | null;
}

/**
 * THE single, atomic, canonical write path for "this user's primary/home
 * department is now X" — the ONLY function that is allowed to write
 * `User.departmentId` going forward (it stays on the schema as a mirror/
 * cache of the active primary DepartmentMembership, never a second
 * independently-writable source of truth — see the User/Department/Member
 * architecture audit this implements).
 *
 * Runs as one bounded transaction per user (never a shared transaction
 * across a batch — see organization-directory-sync-service.ts's own header
 * comment on the real production incident that rule exists to prevent).
 * Guarantees, on successful commit:
 *   - at most one active `isPrimary: true` DepartmentMembership for this user,
 *   - `User.departmentId` equals that membership's `departmentId` (or stays
 *     whatever it already was if this call is blocked/protected — see below),
 *   - a MANUAL secondary membership is NEVER touched by this function at all
 *     (only the current/target primary rows are ever written here).
 *
 * MANUAL-primary protection: if the user's CURRENT active primary is itself
 * source: MANUAL (an admin explicitly chose it) and this call's `source` is
 * anything else (a Microsoft sync signal), the primary is left completely
 * untouched and `outcome: "blocked_manual_primary_protected"` is returned —
 * mirrors syncDepartmentMemberships's existing "MANUAL rows are never
 * modified by sync" rule, applied to the primary designation too. A MANUAL
 * call (an admin explicitly re-choosing) always wins over any previous
 * MANUAL primary, same as it always did.
 */
export async function setPrimaryDepartmentMembership(
  userId: string,
  departmentId: string,
  source: MembershipSource,
  options: SetPrimaryDepartmentMembershipOptions
): Promise<SetPrimaryDepartmentMembershipResult> {
  const { role, deactivateObsoleteMicrosoftPrimary = false } = options;

  return prisma.$transaction(async (tx) => {
    const allMemberships = await tx.departmentMembership.findMany({ where: { userId } });
    const currentPrimary = allMemberships.find((m) => m.isPrimary && m.isActive) ?? null;
    const previousPrimaryDepartmentId = currentPrimary?.departmentId ?? null;

    if (
      currentPrimary &&
      currentPrimary.source === MembershipSource.MANUAL &&
      source !== MembershipSource.MANUAL &&
      currentPrimary.departmentId !== departmentId
    ) {
      return {
        outcome: "blocked_manual_primary_protected" as const,
        primaryMembership: currentPrimary,
        previousPrimaryDepartmentId,
      };
    }

    const targetExisting = allMemberships.find((m) => m.departmentId === departmentId) ?? null;
    const wasAlreadyConsistent =
      !!targetExisting && targetExisting.isActive && targetExisting.isPrimary && previousPrimaryDepartmentId === departmentId;

    // Deliberately NOT delegated to ensurePrimaryDepartmentMembership — that
    // function hardcodes source: MANUAL on create/reactivate (correct for
    // its own direct callers, an admin action), but this function must
    // apply the CALLER's real `source` (MANUAL for admin routes,
    // MICROSOFT_DEPARTMENT for sync). Same protection rules, generalized to
    // any source:
    //  - no row yet -> create with the caller's role/source.
    //  - existing row already source:MANUAL, but THIS call's source isn't
    //    MANUAL -> a Microsoft signal must never downgrade/touch an admin's
    //    manual choice — role/source preserved, only isActive/isPrimary set.
    //  - existing row has a custom department role (customRoleId) -> never
    //    downgraded to a plain enum role, same as ensurePrimaryDepartmentMembership.
    //  - existing ACTIVE row whose role already matches the desired role ->
    //    left untouched (no silent source downgrade for a true no-op).
    //  - otherwise (inactive row being reactivated, or an active row whose
    //    role genuinely differs) -> role/source updated to the caller's values.
    let targetRow: DepartmentMembership;
    if (!targetExisting) {
      targetRow = await tx.departmentMembership.create({
        data: { userId, departmentId, role, source, customRoleId: null, isActive: true, isPrimary: true },
      });
    } else {
      const protectManualFromNonManual = targetExisting.source === MembershipSource.MANUAL && source !== MembershipSource.MANUAL;
      const protectCustomRole = !!targetExisting.customRoleId;
      const roleAlreadyMatches = targetExisting.isActive && targetExisting.role === role;

      if (protectManualFromNonManual || protectCustomRole || roleAlreadyMatches) {
        targetRow =
          targetExisting.isActive && targetExisting.isPrimary
            ? targetExisting
            : await tx.departmentMembership.update({ where: { id: targetExisting.id }, data: { isActive: true, isPrimary: true } });
      } else {
        targetRow = await tx.departmentMembership.update({
          where: { id: targetExisting.id },
          data: { isActive: true, isPrimary: true, role, source, customRoleId: null },
        });
      }
    }

    if (currentPrimary && currentPrimary.id !== targetRow.id) {
      const oldIsManual = currentPrimary.source === MembershipSource.MANUAL;
      const shouldDeactivate = !oldIsManual && deactivateObsoleteMicrosoftPrimary;
      await tx.departmentMembership.update({
        where: { id: currentPrimary.id },
        data: shouldDeactivate ? { isPrimary: false, isActive: false } : { isPrimary: false },
      });
    }

    // Defensive cleanup: demote any OTHER stray active isPrimary rows left
    // over from pre-existing data drift (see the reconciliation script) so
    // this call always leaves AT MOST one active primary, never more,
    // regardless of what state the row set was in before this call.
    for (const m of allMemberships) {
      if (m.id === targetRow.id) continue;
      if (currentPrimary && m.id === currentPrimary.id) continue; // already handled above
      if (m.isPrimary) {
        await tx.departmentMembership.update({ where: { id: m.id }, data: { isPrimary: false } });
      }
    }

    await tx.user.update({ where: { id: userId }, data: { departmentId } });

    const outcome: SetPrimaryDepartmentMembershipOutcome = wasAlreadyConsistent
      ? "unchanged"
      : previousPrimaryDepartmentId === departmentId
        ? "aligned"
        : "switched";

    return { outcome, primaryMembership: targetRow, previousPrimaryDepartmentId };
  });
}
