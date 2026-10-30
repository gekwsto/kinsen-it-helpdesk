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

export interface DepartmentMemberUserSummary {
  id: string;
  name: string | null;
  email: string;
  image: string | null;
}

/**
 * Active users with an active DepartmentMembership in this department — the
 * canonical membership relation itself, with NO permission filtering
 * layered on top. Deliberately distinct from
 * getAssignableUsersForEntity("project", departmentId) in
 * lib/services/assignment-eligibility-service.ts, which additionally
 * requires `project.assignable` (a narrower, separate notion — "can be
 * assigned project WORK," e.g. deliberately withheld from AGENT_ASSIGNEE/
 * IT_AGENT by default, see that permission's own seed comment). This is the
 * eligibility source for a MANUAL Project's plain Members picker (see
 * GET /api/departments/[id]/members, components/projects/project-form.tsx)
 * — "who's in this workspace," full stop, not "who's allowed to be
 * assigned work."
 */
export async function getActiveDepartmentMemberUsers(departmentId: string): Promise<DepartmentMemberUserSummary[]> {
  return prisma.user.findMany({
    where: { isActive: true, departmentMemberships: { some: { departmentId, isActive: true } } },
    select: memberUserSelect,
    orderBy: { name: "asc" },
  });
}

/**
 * Write-time counterpart to getActiveDepartmentMemberUsers above — never
 * trusts a client-submitted memberId list as-is. Dedupes/trims first, then
 * requires EVERY id to resolve to a real, currently-active User with an
 * active DepartmentMembership in `departmentId` specifically (an id valid
 * for some OTHER department is rejected same as a nonexistent one). Fails
 * closed: returns `null` if any id doesn't resolve, the deduplicated array
 * otherwise. Same "every id must be real" contract as
 * resolveSystemWideActiveUserIds in project-request-service.ts, just
 * scoped to one Department's membership instead of system-wide — used by
 * POST /api/projects when (and only when) the request declares
 * memberEligibilitySource: "workspaceMembership" (see
 * createProjectMemberEligibilitySchema in lib/validations.ts).
 */
export async function resolveActiveDepartmentMemberIds(departmentId: string, ids: string[]): Promise<string[] | null> {
  const deduped = Array.from(new Set(ids.map((id) => id.trim()).filter((id) => id.length > 0)));
  if (deduped.length === 0) return deduped;
  const activeCount = await prisma.user.count({
    where: { id: { in: deduped }, isActive: true, departmentMemberships: { some: { departmentId, isActive: true } } },
  });
  return activeCount === deduped.length ? deduped : null;
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
 *   primary, it's promoted to primary (unless `autoPromoteSoleActiveMembership`
 *   is explicitly false — see below) — a fallback for callers with NO
 *   separate primary-placement signal of their own.
 *
 * ROOT-CAUSE FIX (Microsoft/Entra primary-placement integrity): this
 * fallback is NOT harmless for a caller that also calls
 * setPrimaryDepartmentMembership in the same sync run, contrary to what an
 * earlier version of this comment claimed. Both real Microsoft-sync callers
 * (microsoft-department-sync-service.ts's syncMicrosoftUserDepartment,
 * organization-directory-sync-service.ts's directory sync) call
 * setPrimaryDepartmentMembership FIRST, but that call is wrapped in a
 * try/catch that logs and continues on failure (a deliberate, correct
 * choice — a Graph/eligibility hiccup must never abort sign-in) — and
 * `eligibility.eligible` can independently be false for a real, signed-in,
 * domain-valid user (e.g. Entra `userType` reporting something other than
 * "Member" for that specific account) even though a real `department` value
 * came back from Graph. In EITHER case, setPrimaryDepartmentMembership
 * simply never ran this login, leaving zero active primary rows. This
 * function then runs its SECONDARY sync (an entirely independent
 * MicrosoftDepartmentMapping match, e.g. an org-wide "all employees" Entra
 * group mapped to some department for ticket-visibility purposes) and, if
 * that resolves to exactly one active membership, the tail fallback below
 * used to silently promote THAT unrelated secondary-access department to
 * `isPrimary: true` — with NO corresponding User.departmentId write (only
 * setPrimaryDepartmentMembership ever writes that column), so the user was
 * left in a self-contradictory state: User.departmentId null/stale, but
 * DepartmentMembership.isPrimary true on a department Graph's real
 * organizational profile never named. workspace-service.ts's
 * resolveActiveWorkspace resolves a regular user's active workspace from
 * this exact isPrimary row (not from User.departmentId), so the wrong
 * department was what the user actually saw, immediately, on first login —
 * confirmed via reproduction (see scripts/test-microsoft-organization-
 * placement-integrity.ts).
 *
 * Both real Microsoft-sync callers ALWAYS have their own explicit primary-
 * placement mechanism, whether or not it happened to succeed this specific
 * run — the "fallback for callers with no separate primary-placement signal
 * of their own" rationale this tail was built for never actually applies to
 * either of them. Both now pass `autoPromoteSoleActiveMembership: false`.
 * Default stays `true` for any other/future caller that genuinely has no
 * primary-placement mechanism of its own (none exists today — see this
 * function's only two production call sites).
 */
export async function syncDepartmentMemberships(
  userId: string,
  resolved: ResolvedMembership[],
  options: { autoPromoteSoleActiveMembership?: boolean } = {}
): Promise<void> {
  const { autoPromoteSoleActiveMembership = true } = options;
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

    if (autoPromoteSoleActiveMembership) {
      const active = await tx.departmentMembership.findMany({ where: { userId, isActive: true } });
      if (active.length === 1 && !active[0].isPrimary) {
        await tx.departmentMembership.update({
          where: { id: active[0].id },
          data: { isPrimary: true },
        });
      }
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

export type SetPrimaryDepartmentMembershipOutcome = "unchanged" | "aligned" | "switched" | "blocked_primary_protected";

export interface SetPrimaryDepartmentMembershipOptions {
  /** Role to apply to the target row — ignored (existing value preserved) for an existing MANUAL-source or custom-role row, same protection as ensurePrimaryDepartmentMembership. */
  role: DepartmentRole;
  /**
   * Custom department role to apply alongside `role` (which becomes a
   * required-but-unused placeholder once this is set — same convention as
   * grantManualMembership). Resolved by the caller via
   * lib/services/default-role-service.ts's resolveDefaultDepartmentRoleAssignment
   * — this function has no opinion on WHERE the value comes from, it just
   * applies it with the exact same protection rules as `role` (never
   * touched on an existing MANUAL-source or already-custom-role row).
   * Omit/null for the pre-existing "plain enum role, no custom role"
   * behavior.
   */
  customRoleId?: string | null;
  /**
   * Automatic (non-MANUAL) calls ONLY — organization-directory-sync-service.ts,
   * microsoft-department-sync-service.ts, and the SQLGeneral worker's
   * applySqlGeneralPrimaryPlacement: when the CURRENT primary is being
   * replaced, fully deactivate it (isActive:false) instead of just
   * demoting it to a secondary membership — an automated placement should
   * never leave behind old automated department access with no reason.
   * Renamed from deactivateObsoleteMicrosoftPrimary: no longer
   * Microsoft-specific, and no longer conditioned on the OLD row's own
   * source being non-MANUAL — REQUIRED (DO #5): once a primary is
   * unlocked, it is fully deactivated when superseded regardless of
   * whether it happens to be MANUAL-sourced; only primaryLockedById
   * protects a row from ever being reached this way at all (see the
   * blocked_primary_protected check below). Admin-driven (source: MANUAL)
   * calls must never pass this — an explicit admin primary change should
   * never silently revoke the old department's access; the old primary is
   * always just demoted to isPrimary:false, isActive unchanged, for a
   * MANUAL call. Defaults to false.
   */
  deactivateObsoleteAutomaticPrimary?: boolean;
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
 * EXPLICIT PRIMARY LOCK PROTECTION: if the user's CURRENT active primary
 * has `primaryLockedById` set (an admin took the SEPARATE, DELIBERATE
 * "Lock this user's primary department" action — see
 * setPrimaryDepartmentLock below, never implied merely by source: MANUAL)
 * and this call's `source` is anything other than MANUAL, the primary is
 * left completely untouched and `outcome: "blocked_primary_protected"` is
 * returned — an explicit, auditable override, not an inferred one. A
 * MANUAL call (an admin directly re-choosing, via the Edit User flow)
 * always proceeds regardless of lock state — "manual edits remain
 * explicitly authorized" — the lock exists to stop AUTOMATIC writers
 * (Microsoft, SQLGeneral), never a human admin acting directly.
 */
export async function setPrimaryDepartmentMembership(
  userId: string,
  departmentId: string,
  source: MembershipSource,
  options: SetPrimaryDepartmentMembershipOptions
): Promise<SetPrimaryDepartmentMembershipResult> {
  const { role, customRoleId = null, deactivateObsoleteAutomaticPrimary = false } = options;

  return prisma.$transaction(async (tx) => {
    const allMemberships = await tx.departmentMembership.findMany({ where: { userId } });
    const currentPrimary = allMemberships.find((m) => m.isPrimary && m.isActive) ?? null;
    const previousPrimaryDepartmentId = currentPrimary?.departmentId ?? null;

    // Three independent protections against a non-MANUAL caller trying to
    // move a DIFFERENT department's worth of primary onto this user:
    //   1. An explicit admin lock (primaryLockedById) blocks ANY automatic
    //      caller — Microsoft or SQLGeneral alike (REQUIRED DO #4, prior
    //      round).
    //   2. Microsoft specifically (source === MICROSOFT_DEPARTMENT) also
    //      NEVER overrides a MANUAL-sourced primary, locked or not — this
    //      restores Microsoft's original, pre-SQLGeneral-round behavior
    //      (REQUIRED: "preserve existing Microsoft placement behavior" —
    //      that behavior always fully protected a MANUAL choice from
    //      Microsoft, unconditionally). Deliberately NOT extended to
    //      SQLGENERAL_DEPARTMENT: the prior round's explicit decision that
    //      an UNLOCKED MANUAL row may legitimately be moved by SQLGeneral
    //      (a routine admin edit should not permanently block correct
    //      SQLGeneral placement) stays exactly as it was — only an
    //      explicit lock protects a MANUAL row from SQLGeneral.
    //   3. Microsoft specifically also NEVER overrides an unlocked
    //      SQLGENERAL_DEPARTMENT-sourced primary (REQUIRED, duplicate-
    //      prevention round: "ensure Microsoft sync cannot override
    //      SQLGeneral-authoritative primary placement"). The two existing
    //      Microsoft sync callers (organization-directory-sync-service.ts,
    //      microsoft-department-sync-service.ts) already independently
    //      check isPrimaryCompanySqlGeneralAuthoritative before ever
    //      calling this function with source: MICROSOFT_DEPARTMENT — this
    //      makes that convention a STRUCTURAL guarantee enforced here too,
    //      so a future or modified caller can never accidentally regress
    //      it. SQLGeneral's own calls (source: SQLGENERAL_DEPARTMENT) are
    //      completely unaffected — this condition only ever restricts a
    //      MICROSOFT_DEPARTMENT caller, never SQLGeneral's own authority
    //      over a Microsoft-sourced primary.
    if (
      currentPrimary &&
      source !== MembershipSource.MANUAL &&
      currentPrimary.departmentId !== departmentId &&
      (currentPrimary.primaryLockedById !== null ||
        (currentPrimary.source === MembershipSource.MANUAL && source === MembershipSource.MICROSOFT_DEPARTMENT) ||
        (currentPrimary.source === MembershipSource.SQLGENERAL_DEPARTMENT && source === MembershipSource.MICROSOFT_DEPARTMENT))
    ) {
      return {
        outcome: "blocked_primary_protected" as const,
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
    //  - existing row already source:MANUAL -> its role/customRoleId is
    //    NEVER touched by this function, regardless of the CALLER's own
    //    source (including another MANUAL call — see below), only
    //    isActive/isPrimary are ever set. `role` here is only ever a
    //    placement default (translated from the user's GLOBAL role), never
    //    an explicit admin choice for THIS membership's department role —
    //    that's the per-row "Change Role" control's job
    //    (grantManualMembership), a completely separate decision. Root
    //    cause this specifically fixes: an admin grants a department
    //    membership with a deliberately-chosen role (e.g. Agent/Assignee,
    //    source MANUAL), then also sets that SAME department as the user's
    //    Primary Department in the same Edit User save — both actions are
    //    admin-driven (source MANUAL on both), so the OLD "protect MANUAL
    //    only from a NON-manual caller" rule did not apply between them,
    //    and the primary-department call silently overwrote the
    //    just-chosen role back to the global-role-derived default. Setting
    //    "this department is primary" and setting "this is the role in
    //    this department" are two independent decisions; neither may
    //    silently clobber the other.
    //  - existing row has a custom department role (customRoleId) -> never
    //    downgraded/reassigned, checked as its own independent condition
    //    (NOT merely subsumed by the MANUAL-row protection above — since
    //    the configurable Default Department Role, resolved via
    //    lib/services/default-role-service.ts, a source: MICROSOFT_DEPARTMENT
    //    call CAN now also create a customRoleId-bearing row here, not just
    //    a MANUAL one).
    //  - existing ACTIVE row whose role already matches the desired role ->
    //    left untouched (no silent source downgrade for a true no-op).
    //  - otherwise (inactive row being reactivated, or an active
    //    non-MANUAL row whose role genuinely differs, e.g. a stale
    //    MICROSOFT_DEPARTMENT-sourced row) -> role/customRoleId/source
    //    updated to the caller's values.
    let targetRow: DepartmentMembership;
    if (!targetExisting) {
      targetRow = await tx.departmentMembership.create({
        data: { userId, departmentId, role, source, customRoleId, isActive: true, isPrimary: true },
      });
    } else {
      const protectManualRole = targetExisting.source === MembershipSource.MANUAL;
      const protectCustomRole = !!targetExisting.customRoleId;
      const roleAlreadyMatches = targetExisting.isActive && targetExisting.role === role;

      if (protectManualRole || protectCustomRole || roleAlreadyMatches) {
        targetRow =
          targetExisting.isActive && targetExisting.isPrimary
            ? targetExisting
            : await tx.departmentMembership.update({ where: { id: targetExisting.id }, data: { isActive: true, isPrimary: true } });
      } else {
        targetRow = await tx.departmentMembership.update({
          where: { id: targetExisting.id },
          data: { isActive: true, isPrimary: true, role, source, customRoleId },
        });
      }
    }

    if (currentPrimary && currentPrimary.id !== targetRow.id) {
      // No `!oldIsManual` check here (REQUIRED, DO #5) — a LOCKED old
      // primary already blocked this whole call above for any non-MANUAL
      // caller, so by the time execution reaches here the old primary is
      // either unlocked (safe to fully deactivate, including an unlocked
      // MANUAL-sourced one) or this call is itself MANUAL (an admin
      // directly superseding it, which never passes
      // deactivateObsoleteAutomaticPrimary anyway).
      await tx.departmentMembership.update({
        where: { id: currentPrimary.id },
        data: deactivateObsoleteAutomaticPrimary ? { isPrimary: false, isActive: false } : { isPrimary: false },
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

export type SetPrimaryDepartmentLockResult = { ok: true; locked: boolean } | { ok: false; reason: "no_active_primary" };

/**
 * The ONE place that ever writes `DepartmentMembership.primaryLockedById`/
 * `primaryLockedAt` — a deliberate, separate admin action ("Lock this
 * user's primary department against SQLGeneral/Microsoft"), never implied
 * by source: MANUAL and never set as a side effect of
 * setPrimaryDepartmentMembership itself. Locks/unlocks whichever row is
 * CURRENTLY the user's active primary at call time — if that row is later
 * replaced (e.g. a subsequent MANUAL admin change targets a different
 * department), the lock does NOT carry over to the new row automatically;
 * an admin must explicitly re-lock if they want the new department locked
 * too. Fails closed (`no_active_primary`) rather than locking nothing or
 * guessing a department, if the user currently has no active primary at
 * all (e.g. still pending first SQLGeneral placement).
 */
export async function setPrimaryDepartmentLock(userId: string, locked: boolean, lockedById: string): Promise<SetPrimaryDepartmentLockResult> {
  const currentPrimary = await prisma.departmentMembership.findFirst({ where: { userId, isPrimary: true, isActive: true } });
  if (!currentPrimary) return { ok: false, reason: "no_active_primary" };
  await prisma.departmentMembership.update({
    where: { id: currentPrimary.id },
    data: locked ? { primaryLockedById: lockedById, primaryLockedAt: new Date() } : { primaryLockedById: null, primaryLockedAt: null },
  });
  return { ok: true, locked };
}

/**
 * True when this user's CURRENT active primary DepartmentMembership is
 * SQLGENERAL_DEPARTMENT-sourced — the one existing signal both Microsoft
 * sync entry points (login, lib/services/microsoft-department-sync-service.ts;
 * full tenant scan, lib/services/organization-directory-sync-service.ts)
 * check before writing User.companyId, so SQLGeneral's verified Company is
 * never silently clobbered by a later Microsoft sync once it has become
 * authoritative for this user (REQUIRED: resolve the User.companyId
 * dual-writer precedence). Deliberately reuses the EXISTING primary-
 * membership source signal — no new field, no new mechanism — and is
 * checked independently of isSqlGeneralPrimaryPlacementEnabled() so the
 * precedence holds even across a rollout-flag rollback (flipped ON long
 * enough to place a user, then OFF again): Microsoft must still never
 * reclaim a Company it is no longer authoritative for.
 */
export async function isPrimaryCompanySqlGeneralAuthoritative(userId: string): Promise<boolean> {
  const currentPrimary = await prisma.departmentMembership.findFirst({
    where: { userId, isPrimary: true, isActive: true },
    select: { source: true },
  });
  return currentPrimary?.source === MembershipSource.SQLGENERAL_DEPARTMENT;
}
