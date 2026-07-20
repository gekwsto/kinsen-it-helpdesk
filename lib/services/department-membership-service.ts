import { prisma } from "@/lib/prisma";
import type { DepartmentMembership, Prisma } from "@prisma/client";
import { DepartmentRole, MembershipSource } from "@prisma/client";
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
  customRole: { id: string; key: string; name: string } | null;
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
      customRole: { select: { id: true, key: true, name: true } },
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
 * Reconciles a user's DepartmentMembership rows with a freshly-resolved set
 * of memberships (from Microsoft claims, see microsoft-mapping-service).
 *
 * Rules (see the login-sync edge cases in the architecture plan):
 * - A MANUAL row (admin override) is never modified or removed here — it
 *   survives regardless of what the resolved set says.
 * - Resolved tuples are upserted by [userId, departmentId]; an existing
 *   non-MANUAL row gets its role/source updated (a "promotion" is an
 *   update, not a new row).
 * - An existing non-MANUAL, currently-active membership whose department is
 *   no longer in the resolved set is soft-revoked (isActive: false), never
 *   deleted — preserves history and anything referencing the user.
 * - If exactly one active membership exists afterward and none is flagged
 *   primary, it's promoted to primary. Zero or multiple active memberships
 *   are left for the workspace selector (Phase 2 UI) to resolve at request
 *   time — this function never guesses.
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

      if (current) {
        await tx.departmentMembership.update({
          where: { id: current.id },
          data: { role: r.role, source: r.source, isActive: true },
        });
      } else {
        await tx.departmentMembership.create({
          data: { userId, departmentId: r.departmentId, role: r.role, source: r.source },
        });
      }
    }

    // Soft-revoke non-MANUAL memberships whose source claim disappeared.
    for (const current of existing) {
      if (current.source === MembershipSource.MANUAL) continue;
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
 * Ensures an active DepartmentMembership exists for (userId, departmentId),
 * called when an admin sets a user's Primary/Default Department from the
 * Add/Edit User dialog (a passive side effect of an account-level edit) —
 * unlike grantManualMembership above (an explicit, deliberate membership
 * action from the department members / user-memberships UI), this must
 * NEVER clobber an already-active row's source/role unless something
 * actually needs to change, so a Microsoft-synced membership isn't silently
 * downgraded to MANUAL just by re-saving the same primary department:
 *  - no row yet -> create it, source MANUAL, role translated from the
 *    user's global role (see translateGlobalRoleToDepartmentRole).
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
  desiredRole: DepartmentRole
): Promise<DepartmentMembership> {
  const existing = await prisma.departmentMembership.findUnique({
    where: { userId_departmentId: { userId, departmentId } },
  });

  if (!existing) {
    return prisma.departmentMembership.create({
      data: { userId, departmentId, role: desiredRole, customRoleId: null, source: MembershipSource.MANUAL, isActive: true },
    });
  }

  if (!existing.isActive) {
    return prisma.departmentMembership.update({
      where: { id: existing.id },
      data: { isActive: true, source: MembershipSource.MANUAL, role: desiredRole, customRoleId: null },
    });
  }

  if (existing.customRoleId) return existing;
  if (existing.role === desiredRole) return existing;

  return prisma.departmentMembership.update({
    where: { id: existing.id },
    data: { role: desiredRole, source: MembershipSource.MANUAL },
  });
}
