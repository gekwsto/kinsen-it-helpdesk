import { prisma } from "@/lib/prisma";
import type { DepartmentMembership } from "@prisma/client";
import { DepartmentRole, MembershipSource } from "@prisma/client";
import type { DepartmentMembershipView, ResolvedMembership } from "@/types/department";

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
    include: { user: { select: memberUserSelect } },
    orderBy: [{ isActive: "desc" }, { createdAt: "asc" }],
  });
  return rows.map((m) => ({
    id: m.id,
    userId: m.userId,
    departmentId: m.departmentId,
    role: m.role,
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

export async function grantManualMembership(
  userId: string,
  departmentId: string,
  role: DepartmentRole
): Promise<DepartmentMembership> {
  return prisma.departmentMembership.upsert({
    where: { userId_departmentId: { userId, departmentId } },
    update: { role, source: MembershipSource.MANUAL, isActive: true },
    create: { userId, departmentId, role, source: MembershipSource.MANUAL },
  });
}

/** Soft-revoke — never deletes, so ticket/project history referencing the user is unaffected. */
export async function revokeMembership(id: string): Promise<DepartmentMembership> {
  return prisma.departmentMembership.update({ where: { id }, data: { isActive: false } });
}
